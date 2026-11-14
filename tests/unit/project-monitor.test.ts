import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openDatabase } from '../../src/database/connection.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { AgentController } from '../../src/services/agent-controller.js';
import { ProjectMonitor } from '../../src/services/project-monitor.js';
import { TaskManager } from '../../src/services/task-manager.js';

const ROUTER = { sessionId: 'session-router', role: 'router' as const };
const WORKER = 'session-worker-a';

function pastIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function futureIso(): string {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}

/** fake agents 服务：会话为冷（get 返回 undefined → 走 resume 路径）。 */
function fakeAgentService() {
  const agent = {
    id: WORKER,
    status: 'idle' as const,
    options: {},
    followup: () => undefined,
    steer: () => undefined,
    cancel: () => undefined,
    whenIdle: async () => undefined,
  };
  return {
    get: () => undefined,
    list: () => [],
    resume: async () => ({ agent }),
  };
}

async function setup(): Promise<{ monitor: ProjectMonitor; manager: TaskManager; controller: AgentController; db: Awaited<ReturnType<typeof openDatabase>> }> {
  const db = await openDatabase(':memory:');
  const fakeCtx = { get: (name: string) => (name === 'agents' ? fakeAgentService() : {}) } as unknown as Context;
  const manager = new TaskManager(db);
  manager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER });
  const controller = new AgentController(new DshAgentAdapter(fakeCtx), manager, db);
  return { monitor: new ProjectMonitor(manager, controller), manager, controller, db };
}

function runningTask(manager: TaskManager, timeoutAt: string | null): string {
  const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
  manager.enqueue(task.id, ROUTER);
  manager.markDispatched(task.id, WORKER, timeoutAt);
  return task.id;
}

describe('ProjectMonitor 超时看门狗', () => {
  it('无超时任务时扫描返回空结果', async () => {
    const { monitor, manager } = await setup();
    runningTask(manager, futureIso());
    runningTask(manager, null);
    const scan = monitor.scanOnce();
    expect(scan.expired).toEqual([]);
    expect(scan.retried).toEqual([]);
  });

  it('超时任务判 failed 并按预算重排（expired → retried → queued）', async () => {
    const { monitor, manager } = await setup();
    const taskId = runningTask(manager, pastIso());
    const scan = monitor.scanOnce();
    expect(scan.expired).toEqual([taskId]);
    expect(scan.retried).toEqual([taskId]);
    expect(manager.tasks.byId(taskId)?.status).toBe('queued');
    expect(manager.runs.byTask(taskId)[0]?.outcome).toBe('timeout');
  });

  it('重试预算耗尽的任务进 retryExhausted（保持 failed）', async () => {
    const { monitor, manager } = await setup();
    const taskId = runningTask(manager, pastIso());
    let scan = monitor.scanOnce();
    expect(scan.retried).toEqual([taskId]);
    manager.markDispatched(taskId, WORKER, pastIso());
    scan = monitor.scanOnce();
    expect(scan.retried).toEqual([taskId]);
    manager.markDispatched(taskId, WORKER, pastIso());
    scan = monitor.scanOnce();
    expect(scan.expired).toContain(taskId);
    expect(scan.retryExhausted).toContain(taskId);
    expect(manager.tasks.byId(taskId)?.status).toBe('failed');
    expect(manager.tasks.byId(taskId)?.retry_count).toBe(2);
  });

  it('超时释放并发许可（否则重排后的派发永久等待）', async () => {
    const { monitor, manager, controller, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    const dispatch = await controller.dispatchTask(task.id);
    expect(dispatch.dispatched).toBe(true);
    expect(controller.permitsCount()).toBe(1);
    db.prepare('UPDATE tasks SET timeout_at = ? WHERE id = ?').run(pastIso(), task.id);

    const scan = monitor.scanOnce();
    expect(scan.expired).toContain(task.id);
    expect(scan.permitsReleased).toBe(1);
    expect(controller.permitsCount()).toBe(0);
  });

  it('start/stop 幂等（重复调用安全）', async () => {
    const { monitor } = await setup();
    monitor.start();
    monitor.start();
    monitor.stop();
    monitor.stop();
  });
});
