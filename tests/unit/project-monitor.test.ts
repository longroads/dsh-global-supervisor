import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
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

async function setup(): Promise<{ monitor: ProjectMonitor; manager: TaskManager }> {
  const db = await openDatabase(':memory:');
  const manager = new TaskManager(db);
  manager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER });
  return { monitor: new ProjectMonitor(manager, 60_000), manager };
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
    expect(scan).toEqual({ expired: [], retried: [], retryExhausted: [] });
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
    // 完整循环：超时→重试→再派发→再超时，直至预算耗尽（maxRetries 默认 2）
    let scan = monitor.scanOnce();
    expect(scan.retried).toEqual([taskId]); // 第 1 次重试
    manager.markDispatched(taskId, WORKER, pastIso());
    scan = monitor.scanOnce();
    expect(scan.retried).toEqual([taskId]); // 第 2 次重试（预算用尽）
    manager.markDispatched(taskId, WORKER, pastIso());
    scan = monitor.scanOnce();
    expect(scan.expired).toContain(taskId);
    expect(scan.retryExhausted).toContain(taskId);
    expect(manager.tasks.byId(taskId)?.status).toBe('failed');
    expect(manager.tasks.byId(taskId)?.retry_count).toBe(2);
  });

  it('start/stop 幂等（重复调用安全）', async () => {
    const { monitor } = await setup();
    monitor.start();
    monitor.start();
    monitor.stop();
    monitor.stop();
  });
});
