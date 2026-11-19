import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { awaitService, ServiceUnavailableError } from '../../src/adapters/host-services.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { DshSessionAdapter } from '../../src/adapters/dsh-session.js';

/** 构造沙箱形态的 fake ctx：仅 get 通道（沙箱契约下的合法面）。 */
function fakeCtx(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context;
}

function fakeWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ws-1',
    path: 'E:\\proj\\demo',
    title: 'demo',
    sessionIds: ['session-a', 'session-b'],
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T01:00:00.000Z',
    ...overrides,
  };
}

describe('awaitService 等待式解析', () => {
  it('服务就绪立即返回', async () => {
    const ctx = fakeCtx({ tools: { register: () => undefined } });
    const tools = await awaitService<{ register: () => void }>(ctx, 'tools');
    expect(typeof tools.register).toBe('function');
  });

  it('未就绪轮询重试后返回', async () => {
    let calls = 0;
    const ctx = {
      get: () => {
        calls += 1;
        return calls < 3 ? undefined : { ready: true };
      },
    } as unknown as Context;
    const service = await awaitService<{ ready: boolean }>(ctx, 'x', 10, 1);
    expect(service.ready).toBe(true);
    expect(calls).toBe(3);
  });

  it('超时抛 ServiceUnavailableError 并携带服务名', async () => {
    const ctx = fakeCtx({});
    await expect(awaitService(ctx, 'schedule', 3, 1)).rejects.toThrow(ServiceUnavailableError);
    try {
      await awaitService(ctx, 'schedule', 2, 1);
      expect.unreachable('应已抛出');
    } catch (error) {
      expect((error as ServiceUnavailableError).serviceName).toBe('schedule');
    }
  });
});

describe('DshWorkspaceAdapter', () => {
  it('listWorkspaces 映射纯数据视图', async () => {
    const registry = { list: () => [fakeWorkspace(), fakeWorkspace({ id: 'ws-2', title: 't2' })] };
    const adapter = new DshWorkspaceAdapter(fakeCtx({ workspaceRegistry: registry }));
    const list = await adapter.listWorkspaces();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: 'ws-1',
      path: 'E:\\proj\\demo',
      title: 'demo',
      sessionIds: ['session-a', 'session-b'],
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T01:00:00.000Z',
    });
    expect(await adapter.getWorkspace('ws-2')?.then((w) => w?.title)).toBe('t2');
    expect(await adapter.getWorkspace('missing')).toBeUndefined();
  });

  it('createWorkspace 经 registry.create 并映射返回', async () => {
    const created = fakeWorkspace({ id: 'ws-new', title: '新项目' });
    const registry = { list: () => [], create: vi.fn().mockResolvedValue(created) };
    const adapter = new DshWorkspaceAdapter(fakeCtx({ workspaceRegistry: registry }));
    const result = await adapter.createWorkspace('E:\\proj\\new', '新项目');
    expect(registry.create).toHaveBeenCalledWith('E:\\proj\\new', '新项目');
    expect(result.id).toBe('ws-new');
  });
});

describe('DshAgentAdapter 派发编排', () => {
  function fakeAgents(withLive: boolean) {
    const liveAgent = {
      id: 'session-w',
      status: 'idle' as const,
      options: { provider: 'p', model: 'm' },
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
      whenIdle: vi.fn().mockResolvedValue(undefined),
    };
    const resumeHandle = {
      agent: { ...liveAgent, followup: vi.fn(), steer: vi.fn() },
    };
    const agents = {
      get: vi.fn().mockReturnValue(withLive ? liveAgent : undefined),
      list: vi.fn().mockReturnValue(withLive ? [liveAgent] : []),
      resume: vi.fn().mockResolvedValue(resumeHandle),
    };
    return { agents, liveAgent, resumeHandle };
  }

  it('活跃会话直接 followup，不走 resume', async () => {
    const { agents, liveAgent } = fakeAgents(true);
    const adapter = new DshAgentAdapter(fakeCtx({ agents }));
    await adapter.dispatch('session-w', '检查项目进度');
    expect(agents.resume).not.toHaveBeenCalled();
    expect(liveAgent.followup).toHaveBeenCalledTimes(1);
    const message = liveAgent.followup.mock.calls[0]?.[0] as {
      role: string;
      content: Array<{ type: string; text: string }>;
      source: { kind: string };
    };
    expect(message.role).toBe('user');
    expect(message.content[0]?.text).toBe('检查项目进度');
    expect(message.source.kind).toBe('user');
  });

  it('冷会话先 resume 再 followup（get-or-resume）', async () => {
    const { agents, resumeHandle } = fakeAgents(false);
    const adapter = new DshAgentAdapter(fakeCtx({ agents }));
    await adapter.dispatch('session-w', '任务 A');
    expect(agents.resume).toHaveBeenCalledWith({ resumeSessionId: 'session-w' });
    expect(resumeHandle.agent.followup).toHaveBeenCalledTimes(1);
  });

  it('isBusy 语义：running 为忙，idle/无活动为闲', async () => {
    const { agents, liveAgent } = fakeAgents(true);
    const adapter = new DshAgentAdapter(fakeCtx({ agents }));
    liveAgent.status = 'running';
    expect(await adapter.isBusy('session-w')).toBe(true);
    liveAgent.status = 'idle';
    expect(await adapter.isBusy('session-w')).toBe(false);
    expect(await adapter.isBusy('session-none')).toBe(false);
  });
});

describe('FB-17 createSession 就绪轮询', () => {
  it('create 后 registry 延迟登记：轮询至可见返回 true', async () => {
    let getCalls = 0;
    const agents = {
      get: vi.fn(() => {
        getCalls += 1;
        return getCalls >= 3 ? { id: 'session-new', status: 'idle' } : undefined;
      }),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new DshAgentAdapter(fakeCtx({ agents }));
    const ready = await adapter.createSession('session-new', 'E:\\proj\\p1', { readyTimeoutMs: 2000 });
    expect(ready).toBe(true);
    expect(agents.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-new', meta: { cwd: 'E:\\proj\\p1' } }));
    expect(getCalls).toBeGreaterThanOrEqual(3);
  });

  it('registry 始终不可见：有界超时返回 false 而非挂起', async () => {
    const agents = {
      get: vi.fn().mockReturnValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new DshAgentAdapter(fakeCtx({ agents }));
    const started = Date.now();
    const ready = await adapter.createSession('session-new', 'E:\\proj\\p1', { readyTimeoutMs: 400 });
    expect(ready).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(agents.get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('registry 立即可见：一次命中无额外等待', async () => {
    const agents = {
      get: vi.fn().mockReturnValue({ id: 'session-new', status: 'idle' }),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new DshAgentAdapter(fakeCtx({ agents }));
    expect(await adapter.createSession('session-new', 'E:\\proj\\p1')).toBe(true);
    expect(agents.get).toHaveBeenCalledTimes(1);
  });
});

describe('DshSessionAdapter', () => {
  it('快照映射与会话存在性判断', async () => {
    const persistence = {
      list: vi.fn().mockResolvedValue([
        { sessionId: 'session-a', header: { id: 'session-a', cwd: 'E:\\a' }, revision: 3, sizeBytes: 1024 },
        { header: { id: 'session-b', cwd: 'E:\\b' }, revision: 1 },
      ]),
    };
    const adapter = new DshSessionAdapter(fakeCtx({ sessionPersistence: persistence }));
    const snapshots = await adapter.listSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.sessionId).toBe('session-a');
    expect(snapshots[0]?.cwd).toBe('E:\\a');
    expect(snapshots[1]?.sessionId).toBe('session-b');
    expect(await adapter.sessionExists('session-b')).toBe(true);
    expect(await adapter.sessionExists('session-x')).toBe(false);
  });
});
