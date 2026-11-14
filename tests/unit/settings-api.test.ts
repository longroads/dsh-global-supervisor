import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openDatabase } from '../../src/database/connection.js';
import { DshSessionAdapter } from '../../src/adapters/dsh-session.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';
import { RouterIdentity } from '../../src/services/router-identity.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { registerSettingsApi } from '../../src/services/settings-api.js';
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
  it('注册三条路由：settings（resource）、client-ping 与 claim（handler）', async () => {
    const { ctx, routes } = fakeCtxWithWebServer();
    const stack = await buildStack(ctx);
    await registerSettingsApi(ctx, stack);
    expect(routes.map((r) => r.path)).toEqual(['/global-supervisor/settings', '/global-supervisor/client-ping', '/global-supervisor/claim']);
    expect(typeof routes[0]?.resource).toBe('function');
    expect(typeof routes[2]?.handler).toBe('function');
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
});
