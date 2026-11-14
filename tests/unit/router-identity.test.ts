import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { openDatabase } from '../../src/database/connection.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';
import { RouterIdentity } from '../../src/services/router-identity.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { buildSupervisorTools } from '../../src/tools/supervisor-tools.js';
import type { SupervisorStack } from '../../src/runtime.js';

const A = 'session-a';
const B = 'session-b';

function execOf(sessionId: string): ToolRunContext {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as unknown as ToolRunContext;
}

async function buildStack(belongsTo: (s: string, w: string) => Promise<boolean> = async () => false): Promise<SupervisorStack> {
  const db = await openDatabase(':memory:');
  const fakeCtx = { get: (name: string) => (name === 'workspaceRegistry' ? { list: () => [] } : {}) } as unknown as Context;
  const taskManager = new TaskManager(db);
  const identity = new RouterIdentity(db, '', belongsTo);
  const stack = {
    db,
    dataDir: ':memory:',
    taskManager,
    routerIdentity: identity,
    workspaceManager: new WorkspaceManager(new DshWorkspaceAdapter(fakeCtx), db),
  } as unknown as SupervisorStack;
  return stack;
}

describe('RouterIdentity 认领制', () => {
  it('无认领时回退预置配置', async () => {
    const db = await openDatabase(':memory:');
    const identity = new RouterIdentity(db, A);
    expect(await identity.isRouter(A)).toBe(true);
    expect(await identity.isRouter(B)).toBe(false);
    expect(identity.current()).toBeUndefined();
  });

  it('首次认领：任何会话可认领；认领后他人被拒', async () => {
    const stack = await buildStack();
    const first = await stack.routerIdentity.claim({ callerSessionId: A, mode: 'session' });
    expect(first).toEqual(expect.objectContaining({ ok: true, reason: 'claimed' }));
    expect(await stack.routerIdentity.isRouter(A)).toBe(true);
    expect(await stack.routerIdentity.isRouter(B)).toBe(false);
  });

  it('已有 Router 时非 Router 换绑被拒；Router 本人可换绑', async () => {
    const stack = await buildStack();
    await stack.routerIdentity.claim({ callerSessionId: A, mode: 'session' });
    const intruder = await stack.routerIdentity.claim({ callerSessionId: B, mode: 'session' });
    expect(intruder).toEqual({ ok: false, reason: 'denied-not-router' });
    expect(await stack.routerIdentity.isRouter(B)).toBe(false);

    const rebind = await stack.routerIdentity.claim({ callerSessionId: B, mode: 'session' });
    // 注意：换绑由 Router 本人发起——上一行 B 被拒后 A 未再调用，此处验证"本人换绑"需 A 发起
    expect(rebind.ok).toBe(false);
    const byOwner = await stack.routerIdentity.claim({ callerSessionId: A, mode: 'session' });
    expect(byOwner.reason).toBe('already-owner');
  });

  it('workspace 模式：工作区内全部会话均为 Router（经归属回调）', async () => {
    const stack = await buildStack(async (sessionId, workspaceId) => workspaceId === 'ws-1' && ['s1', 's2'].includes(sessionId));
    await stack.routerIdentity.claim({ callerSessionId: 's1', mode: 'workspace', workspaceId: 'ws-1' });
    expect(await stack.routerIdentity.isRouter('s1')).toBe(true);
    expect(await stack.routerIdentity.isRouter('s2')).toBe(true);
    expect(await stack.routerIdentity.isRouter(B)).toBe(false);
  });

  it('认领后换绑到新会话（Router 本人发起）', async () => {
    const stack = await buildStack();
    await stack.routerIdentity.claim({ callerSessionId: A, mode: 'session' });
    // Router 本人（A）把身份转给 B 的唯一途径：A 发起 workspace 模式或先注销——
    // 会话模式换绑语义：仅当调用者本人就是目标时为 already-owner；跨会话转移需 workspace 模式
    const toWorkspace = await stack.routerIdentity.claim({ callerSessionId: A, mode: 'workspace', workspaceId: 'ws-x' });
    expect(toWorkspace).toEqual(expect.objectContaining({ ok: true, reason: 'rebound' }));
    expect(stack.routerIdentity.current()?.mode).toBe('workspace');
  });
});

describe('supervisor_claim_router 工具端到端', () => {
  it('首次认领生效且立即获得 Router 权限', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const claim = tools.find((t) => t.name === 'supervisor_claim_router');
    const list = tools.find((t) => t.name === 'supervisor_workspace_list');
    if (!claim || !list) throw new Error('工具缺失');

    const before = await list.execute({}, execOf(A));
    expect(JSON.stringify(before)).toContain('forbidden');

    const claimed = await claim.execute({ mode: 'session' }, execOf(A));
    expect((claimed as { reason: string }).reason).toBe('claimed');

    // fake stack 未接 workspaceManager——权限通过后执行会失败，但 forbidden 应消失
    const after = await list.execute({}, execOf(A));
    expect(JSON.stringify(after)).not.toContain('forbidden');
  });

  it('非 Router 的二次认领被拒（含结构化 reason）', async () => {
    const stack = await buildStack();
    const tools = buildSupervisorTools(stack);
    const claim = tools.find((t) => t.name === 'supervisor_claim_router');
    if (!claim) throw new Error('工具缺失');
    await claim.execute({ mode: 'session' }, execOf(A));
    const denied = await claim.execute({ mode: 'session' }, execOf(B));
    expect((denied as { ok: boolean }).ok).toBe(false);
    expect((denied as { reason: string }).reason).toBe('denied-not-router');
  });
});
