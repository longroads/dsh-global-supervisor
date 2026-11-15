import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openDatabase } from '../../src/database/connection.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { AgentController } from '../../src/services/agent-controller.js';
import { TaskManager } from '../../src/services/task-manager.js';

const WORKER = 'session-worker-a';
const ROUTER = { sessionId: 'session-router', role: 'router' as const };

interface SelectCall {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

function fakeCtx(agentPresent: boolean, selects: SelectCall[]) {
  const liveAgent = {
    id: WORKER,
    status: 'idle',
    options: {},
    model: { select: (s: SelectCall) => { selects.push(s); }, current: () => undefined },
    followup: () => undefined,
    steer: () => undefined,
    cancel: () => undefined,
    whenIdle: async () => undefined,
  };
  return {
    get: (name: string) =>
      name === 'agents'
        ? { get: (sessionId: string) => (agentPresent && sessionId === WORKER ? liveAgent : undefined), list: () => (agentPresent ? [liveAgent] : []), resume: async () => ({ agent: liveAgent }) }
        : {},
  } as unknown as Context;
}

/** 组装派发链夹具（真实 TaskManager + AgentController + 假 agents 服务）。 */
async function setup(agentPresent = true) {
  const db = await openDatabase(':memory:');
  const selects: SelectCall[] = [];
  const adapter = new DshAgentAdapter(fakeCtx(agentPresent, selects));
  const taskManager = new TaskManager(db);
  taskManager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER });
  const controller = new AgentController(adapter, taskManager, db);
  return { db, selects, taskManager, controller };
}

/** 造一个已入队任务（queued——markDispatched 由 dispatchTask 承担）。 */
async function runningTask(taskManager: TaskManager): Promise<string> {
  const task = taskManager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
  taskManager.enqueue(task.id, ROUTER);
  return task.id;
}

describe('模型偏好派发链（Phase 6 6-B）', () => {
  it('无偏好时派发不调用 select', async () => {
    const { db, selects, taskManager, controller } = await setup();
    const taskId = await runningTask(taskManager);
    const dispatch = await controller.dispatchTask(taskId);
    expect(dispatch.dispatched).toBe(true);
    expect(selects).toHaveLength(0);
    db.close();
  });

  it('项目偏好派发时应用；任务偏好优先；畸形偏好不阻断派发', async () => {
    const { db, selects, taskManager, controller } = await setup();
    taskManager.projects.update('proj-1', { modelPrefJson: '{"provider":"p1","model":"m1"}' });
    const taskId = await runningTask(taskManager);
    await controller.dispatchTask(taskId);
    expect(selects).toHaveLength(1);
    expect(selects[0]).toEqual({ provider: 'p1', model: 'm1' });
    await controller.cancelTask(taskId, { role: 'system' });

    const second = await runningTask(taskManager);
    taskManager.tasks.setModelPref(second, '{"provider":"p1","model":"m2","reasoningEffort":"high"}');
    await controller.dispatchTask(second);
    expect(selects[1]).toEqual({ provider: 'p1', model: 'm2', reasoningEffort: 'high' });
    await controller.cancelTask(second, { role: 'system' });

    // 畸形任务偏好：不应用垃圾值也不阻断派发（清除项目偏好以隔离——否则正确回落到项目默认）
    taskManager.projects.update('proj-1', { modelPrefJson: null });
    const third = await runningTask(taskManager);
    taskManager.tasks.setModelPref(third, 'not-json');
    const degraded = await controller.dispatchTask(third);
    expect(degraded.dispatched).toBe(true);
    expect(selects).toHaveLength(2);
    db.close();
  });

  it('selectModelNow：live 会话立即生效，冷会话返回 false', async () => {
    const live = await setup(true);
    expect(await live.controller.applySessionModel(WORKER, { provider: 'p1', model: 'm1' })).toBe(true);
    expect(live.selects).toHaveLength(1);
    live.db.close();

    const cold = await setup(false);
    expect(await cold.controller.applySessionModel(WORKER, { provider: 'p1', model: 'm1' })).toBe(false);
    expect(cold.selects).toHaveLength(0);
    cold.db.close();
  });
});
