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
import type { SupervisorStack } from '../../src/runtime.js';

interface CapturedRoute {
  kind: string;
  path: string;
  resource?: (request: Request) => Promise<Response>;
  handler?: (req: unknown, res: unknown) => Promise<void> | void;
}

function fakeCtxWithWebServer(): { ctx: Context; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const ctx = {
    get: (name: string) =>
      name === 'webServer'
        ? { register: (route: CapturedRoute) => { routes.push(route); return () => undefined; } }
        : name === 'workspaceRegistry'
          ? { list: () => [{ id: 'ws-1', path: 'E:\\a', title: 'alpha', sessionIds: ['s-1'], createdAt: '', updatedAt: '' }] }
          : name === 'sessionPersistence'
            ? { list: () => [{ sessionId: 's-1', header: { id: 's-1', cwd: 'E:\\a', createdAt: 1731400000000 }, revision: 1 }] }
            : {},
  } as unknown as Context;
  return { ctx, routes };
}

async function buildStack(ctx: Context): Promise<SupervisorStack> {
  const db = await openDatabase(':memory:');
  const taskManager = new TaskManager(db);
  return {
    db,
    dataDir: ':memory:',
    taskManager,
    routerIdentity: new RouterIdentity(db, ''),
    workspaceManager: new WorkspaceManager(new DshWorkspaceAdapter(ctx), db),
    sessionAdapter: new DshSessionAdapter(ctx),
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
  it('注册四条路由：settings（resource）、client-ping、claim 与 events（handler）', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    expect(routes.map((r) => r.path)).toEqual(['/global-supervisor/settings', '/global-supervisor/client-ping', '/global-supervisor/claim', '/global-supervisor/events']);
    expect(typeof routes[0]?.resource).toBe('function');
    expect(typeof routes[2]?.handler).toBe('function');
    expect(routes[3]?.kind).toBe('prefix');
    expect(typeof routes[3]?.handler).toBe('function');
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
