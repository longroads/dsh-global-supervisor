import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openDatabase } from '../../src/database/connection.js';
import { DshSessionAdapter } from '../../src/adapters/dsh-session.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';
import { RouterIdentity } from '../../src/services/router-identity.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { EventManager } from '../../src/services/event-manager.js';
import { redact, registerSettingsApi } from '../../src/services/settings-api.js';
import { UpdateChecker } from '../../src/services/update-checker.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import type { SupervisorStack } from '../../src/runtime.js';

interface CapturedRoute {
  kind: string;
  path: string;
  resource?: (request: Request) => Promise<Response>;
  handler?: (req: unknown, res: unknown) => Promise<void> | void;
}

/** fake ctx：webServer 记录注册/注销，effect 收集 disposer（模拟插件 fiber 卸载）。 */
function fakeCtxWithWebServer(options: { duplicatePaths?: string[]; failPathsWith?: RegExp } = {}): {
  ctx: Context;
  routes: CapturedRoute[];
  unregistered: string[];
  disposers: Array<() => void>;
  warnings: string[];
} {
  const routes: CapturedRoute[] = [];
  const unregistered: string[] = [];
  const disposers: Array<() => void> = [];
  const warnings: string[] = [];
  const duplicatePaths = options.duplicatePaths ?? [];
  const failPathsWith = options.failPathsWith;
  const ctx = {
    get: (name: string) =>
      name === 'webServer'
        ? {
            register: (route: CapturedRoute) => {
              if (duplicatePaths.includes(route.path)) {
                throw new Error(`duplicate exact route "${route.path}"`);
              }
              if (failPathsWith?.test(route.path)) {
                throw new Error('boom: webserver internal error');
              }
              routes.push(route);
              unregistered.push(`pending:${route.path}`);
              return () => {
                unregistered[unregistered.indexOf(`pending:${route.path}`)] = `released:${route.path}`;
              };
            },
          }
        : name === 'workspaceRegistry'
          ? { list: () => [{ id: 'ws-1', path: 'E:\\a', title: 'alpha', sessionIds: ['s-1'], createdAt: '', updatedAt: '' }] }
          : name === 'sessionPersistence'
            ? { list: () => [{ sessionId: 's-1', header: { id: 's-1', cwd: 'E:\\a', createdAt: 1731400000000 }, revision: 1 }] }
            : {},
    effect: (execute: () => () => void) => {
      disposers.push(execute());
    },
    logger: { warn: (message: string) => warnings.push(message), info: () => undefined, error: () => undefined },
  } as unknown as Context;
  return { ctx, routes, unregistered, disposers, warnings };
}

async function buildStack(ctx: Context, projcacheDir?: string): Promise<SupervisorStack> {
  const db = await openDatabase(':memory:');
  const taskManager = new TaskManager(db);
  return {
    db,
    dataDir: ':memory:',
    taskManager,
    routerIdentity: new RouterIdentity(db, ''),
    workspaceManager: new WorkspaceManager(new DshWorkspaceAdapter(ctx), db),
    sessionAdapter: new DshSessionAdapter(ctx, projcacheDir),
    eventManager: new EventManager(db),
  } as unknown as SupervisorStack;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 0,
    body: '',
    setHeader(k: string, v: string) { headers[k] = v; },
    end(v: string) { this.body = v; },
  };
}

describe('设置面板 HTTP API', () => {
  it('注册五条路由：settings（resource）、client-ping、claim、events（prefix）、update-check', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    expect(routes.map((r) => r.path)).toEqual(['/global-supervisor/settings', '/global-supervisor/client-ping', '/global-supervisor/claim', '/global-supervisor/events', '/global-supervisor/update-check']);
    expect(typeof routes[0]?.resource).toBe('function');
    expect(typeof routes[2]?.handler).toBe('function');
    expect(routes[3]?.kind).toBe('prefix');
    expect(typeof routes[3]?.handler).toBe('function');
  });

  it('热重载生命周期（2026-11-17 反馈修复）：每条路由 disposer 绑定 ctx.effect，插件卸载时全部释放', async () => {
    const { ctx, routes, disposers, unregistered } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    expect(routes).toHaveLength(5);
    expect(disposers).toHaveLength(5);
    expect(unregistered.every((entry) => entry.startsWith('pending:'))).toBe(true);
    // 模拟插件 fiber 卸载：执行全部 effect disposer → 5 条路由全部释放
    for (const dispose of disposers) dispose();
    expect(unregistered.every((entry) => entry.startsWith('released:'))).toBe(true);
    expect(unregistered).toHaveLength(5);
  });

  it('duplicate 路由（热重载旧实例未释放）降级沿用旧路由，不抛错、其余路由照常注册', async () => {
    const { ctx, routes, warnings } = fakeCtxWithWebServer({ duplicatePaths: ['/global-supervisor/settings'] });
    const stack = await buildStack(ctx);
    await expect(registerSettingsApi(ctx, stack)).resolves.toBeUndefined();
    expect(routes.map((r) => r.path)).toEqual(['/global-supervisor/client-ping', '/global-supervisor/claim', '/global-supervisor/events', '/global-supervisor/update-check']);
    expect(warnings.some((w) => w.includes('/global-supervisor/settings') && w.includes('duplicate'))).toBe(true);
  });

  it('非 duplicate 的注册错误仍上抛（不吞真实故障）', async () => {
    const { ctx } = fakeCtxWithWebServer({ failPathsWith: /client-ping/ });
    const stack = await buildStack(ctx);
    await expect(registerSettingsApi(ctx, stack)).rejects.toThrow('boom');
  });

  it('GET settings 返回 workspace 清单与当前 Router（null 表示未设置）', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    const response = await routes[0]?.resource?.(new Request('http://x/global-supervisor/settings'));
    const payload = (await response?.json()) as { router: unknown; workspaces: Array<{ id: string; sessions: Array<{ id: string; label: string }> }> };
    expect(payload.router).toBeNull();
    expect(payload.workspaces[0]?.id).toBe('ws-1');
    expect(payload.workspaces[0]?.sessions[0]?.id).toBe('s-1');
    expect(payload.workspaces[0]?.sessions[0]?.label).toContain('a · 20');
  });

  it('GET settings 会话名经 projcache 缓存解析（服务空 → 读 record.rows.title.val）', async () => {
    const projcacheDir = mkdtempSync(join(tmpdir(), 'projcache-settings-'));
    try {
      writeFileSync(join(projcacheDir, 's-1.json'), JSON.stringify({ record: { rows: { title: { val: 'JumpServer 登录表单选择器配置咨询' } } } }), 'utf8');
      const { ctx, routes } = fakeCtxWithWebServer();
      const stack = await buildStack(ctx, projcacheDir);
      await registerSettingsApi(ctx, stack);
      const response = await routes[0]?.resource?.(new Request('http://x/global-supervisor/settings'));
      const payload = (await response?.json()) as { workspaces: Array<{ sessions: Array<{ id: string; label: string }> }> };
      expect(payload.workspaces[0]?.sessions[0]?.label).toBe('JumpServer 登录表单选择器配置咨询');
    } finally {
      rmSync(projcacheDir, { recursive: true, force: true });
    }
  });

  it('GET settings update 字段缺省：夹具栈无 updateChecker → disabled=true 且 current=PLUGIN_VERSION', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    const response = await routes[0]?.resource?.(new Request('http://x/global-supervisor/settings'));
    const payload = (await response?.json()) as { update: { disabled: boolean; current: string } };
    expect(payload.update.disabled).toBe(true);
    expect(payload.update.current).toBe(PLUGIN_VERSION);
  });

  it('POST update-check：强制刷新返回状态（fake registry）；跨源 403', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    let calls = 0;
    stack.updateChecker = new UpdateChecker({
      fetchImpl: (() => {
        calls += 1;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ version: '99.9.9' }) });
      }) as unknown as typeof fetch,
    });
    await registerSettingsApi(ctx, stack);
    const req = { method: 'POST', headers: { origin: 'http://h:1', host: 'h:1' }, on: (_e: string, cb: (c?: Buffer) => void) => cb() };
    const res = fakeRes();
    await routes[4]?.handler?.(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; state: { latest: string | null; updateAvailable: boolean; source: string | null } };
    expect(body.ok).toBe(true);
    expect(body.state.latest).toBe('99.9.9');
    expect(body.state.updateAvailable).toBe(true);
    expect(body.state.source).toBe('npm');
    expect(calls).toBeGreaterThanOrEqual(1);
    const resBad = fakeRes();
    await routes[4]?.handler?.({ method: 'POST', headers: { origin: 'http://evil', host: 'h:1' }, on: (_e: string, cb: (c?: Buffer) => void) => cb() }, resBad);
    expect(resBad.statusCode).toBe(403);
  });

  it('POST claim：合法体指派成功并写入身份', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    const chunks: Buffer[] = [Buffer.from(JSON.stringify({ mode: 'session', sessionId: 's-9' }))];
    const req = {
      headers: { origin: 'http://h:1', host: 'h:1' },
      on: (event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') chunks.forEach((c) => cb(c));
        if (event === 'end') cb();
      },
    };
    const res = fakeRes();
    await routes[2]?.handler?.(req, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).router.sessionId).toBe('s-9');
    expect(stack.routerIdentity.current()?.sessionId).toBe('s-9');
  });

  it('POST claim：跨源 Origin 拒绝 403；畸形体 400', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);

    const badOrigin = { headers: { origin: 'http://evil', host: 'h:1' }, on: (_e: string, cb: (c?: Buffer) => void) => cb() };
    const res1 = fakeRes();
    await routes[2]?.handler?.(badOrigin, res1);
    expect(res1.statusCode).toBe(403);

    const badBody = { headers: { origin: 'http://h:1', host: 'h:1' }, on: (event: string, cb: (chunk?: Buffer) => void) => { if (event === 'data') cb(Buffer.from('not-json')); if (event === 'end') cb(); } };
    const res2 = fakeRes();
    await routes[2]?.handler?.(badBody, res2);
    expect(res2.statusCode).toBe(400);
  });

  it('同源判定按 host 比较（scheme 不敏感）：https 面板访问 claim/webhook 放行，异 host 与畸形 Origin 拒绝', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack, { webhookSources: [], maxEventTextChars: 4000, redactPatterns: true });
    const emit = (headers: Record<string, string>, body: unknown) => {
      const chunks: Buffer[] = [Buffer.from(JSON.stringify(body))];
      return {
        method: 'POST',
        headers,
        on: (event: string, cb: (chunk?: Buffer) => void) => {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
        },
      };
    };
    // 事故回归：DSH Web 面经 https 提供时浏览器 Origin 是 https://<host>，必须放行
    const claimHttps = emit({ origin: 'https://10.10.1.222:10443', host: '10.10.1.222:10443' }, { mode: 'session', sessionId: 's-https' });
    const res1 = fakeRes();
    await routes[2]?.handler?.(claimHttps, res1);
    expect(res1.statusCode).toBe(200);
    const hookHttps = emit({ origin: 'https://h:1', host: 'h:1' }, { source: 'github', type: 'x', event_id: 'https-1' });
    const res2 = fakeRes();
    await routes[3]?.handler?.(hookHttps, res2);
    expect(res2.statusCode).toBe(202);
    // 异 host（含 https 伪同源）仍拒绝
    const claimEvil = emit({ origin: 'https://evil:10443', host: '10.10.1.222:10443' }, { mode: 'session', sessionId: 's-x' });
    const res3 = fakeRes();
    await routes[2]?.handler?.(claimEvil, res3);
    expect(res3.statusCode).toBe(403);
    const hookMalformed = emit({ origin: 'not a url', host: 'h:1' }, { source: 'github', type: 'x' });
    const res4 = fakeRes();
    await routes[3]?.handler?.(hookMalformed, res4);
    expect(res4.statusCode).toBe(403);
  });

  it('POST webhook：合法事件 202 入库携带 thread/channel 元数据；同 event_id 重复投递返回 duplicate', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack, { webhookSources: [], maxEventTextChars: 4000, redactPatterns: true });
    const post = (body: unknown) => {
      const chunks: Buffer[] = [Buffer.from(JSON.stringify(body))];
      return {
        method: 'POST',
        headers: {},
        on: (event: string, cb: (chunk?: Buffer) => void) => {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
        },
      };
    };
    const res1 = fakeRes();
    await routes[3]?.handler?.(post({ source: 'github', type: 'issue.opened', event_id: 'gh-1', thread_id: '42', payload: { body: 'hello' } }), res1);
    expect(res1.statusCode).toBe(202);
    expect(JSON.parse(res1.body).inserted).toBe(true);
    const row = stack.eventManager.repository.byEventId('webhook:github:gh-1');
    expect(row?.thread_id).toBe('42');
    expect(row?.channel_ref).toBe('webhook:github');
    const res2 = fakeRes();
    await routes[3]?.handler?.(post({ source: 'github', type: 'issue.opened', event_id: 'gh-1' }), res2);
    expect(JSON.parse(res2.body).duplicate).toBe(true);
  });

  it('POST webhook：凭证脱敏——ghp_ token 在入库负载中被替换', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack, { webhookSources: [], maxEventTextChars: 4000, redactPatterns: true });
    const res = fakeRes();
    const chunks: Buffer[] = [Buffer.from(JSON.stringify({ source: 'ci', type: 'log.pushed', event_id: 'ci-9', payload: { body: 'token ghp_abcdefghijklmnopqrst012345 end' } }))];
    await routes[3]?.handler?.({
      method: 'POST',
      headers: {},
      on: (event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') chunks.forEach((c) => cb(c));
        if (event === 'end') cb();
      },
    }, res);
    expect(res.statusCode).toBe(202);
    const row = stack.eventManager.repository.byEventId('webhook:ci:ci-9');
    expect(row?.payload_json).toContain('[REDACTED]');
    expect(row?.payload_json).not.toContain('ghp_abcdef');
  });

  it('POST webhook：GET 405；跨源 403；缺 type 400；来源不在白名单 403', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack, { webhookSources: ['github'], maxEventTextChars: 4000, redactPatterns: true });
    const emit = (method: string, headers: Record<string, string>, body: unknown) => {
      const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
      return {
        method,
        headers,
        on: (event: string, cb: (chunk?: Buffer) => void) => {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
        },
      };
    };
    const res1 = fakeRes();
    await routes[3]?.handler?.(emit('GET', {}, undefined), res1);
    expect(res1.statusCode).toBe(405);
    const res2 = fakeRes();
    await routes[3]?.handler?.(emit('POST', { origin: 'http://evil', host: 'h:1' }, {}), res2);
    expect(res2.statusCode).toBe(403);
    const res3 = fakeRes();
    await routes[3]?.handler?.(emit('POST', {}, { source: 'gitlab', type: 'x' }), res3);
    expect(res3.statusCode).toBe(403);
    const res4 = fakeRes();
    await routes[3]?.handler?.(emit('POST', {}, { source: 'github' }), res4);
    expect(res4.statusCode).toBe(400);
  });

  it('redact()：五类凭证模式均被替换，普通文本不受影响', () => {
    expect(redact(`ghp_${'a'.repeat(30)}`)).toBe('[REDACTED]');
    expect(redact(`github_pat_${'b'.repeat(30)}`)).toBe('[REDACTED]');
    expect(redact('Bearer abcdef1234567890')).toBe('[REDACTED]');
    expect(redact('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe('[REDACTED]');
    expect(redact('api_key=Abcdef1234567890xyz')).toBe('[REDACTED]');
    expect(redact('普通文本 token_id 不受影响')).toBe('普通文本 token_id 不受影响');
  });
});
