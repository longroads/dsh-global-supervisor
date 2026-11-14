import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import { TaskManager } from '../../src/services/task-manager.js';
import { parseWorkerReport } from '../../src/protocols/worker-report.js';

const ROUTER = { sessionId: 'session-router', role: 'router' as const };
const WORKER = 'session-worker-a';

function pastIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function futureIso(): string {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}

async function setup(): Promise<{ manager: TaskManager; db: Awaited<ReturnType<typeof openDatabase>> }> {
  const db = await openDatabase(':memory:');
  const manager = new TaskManager(db);
  manager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER });
  return { manager, db };
}

/** 建立一个处于 running 状态的任务并按指定超时时间派发。 */
function runningTask(manager: TaskManager, timeoutAt: string | null): string {
  const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
  manager.enqueue(task.id, ROUTER);
  manager.markDispatched(task.id, WORKER, timeoutAt);
  return task.id;
}

describe('Host 重启存疑恢复', async () => {
  it('超时窗口已过的任务判 failed/timeout，未过的保持 running', async () => {
    const { manager, db } = await setup();
    const expiredId = runningTask(manager, pastIso());
    const aliveId = runningTask(manager, futureIso());
    const noDeadlineId = runningTask(manager, null);

    const result = manager.recoverFromRestart();

    expect(result.expiredIds).toEqual([expiredId]);
    expect(result.pendingIds.sort()).toEqual([aliveId, noDeadlineId].sort());
    expect(manager.tasks.byId(expiredId)?.status).toBe('failed');
    expect(manager.runs.byTask(expiredId)[0]?.outcome).toBe('timeout');
    expect(manager.tasks.byId(aliveId)?.status).toBe('running');
    expect(manager.tasks.byId(noDeadlineId)?.status).toBe('running');
    db.close();
  });

  it('每个任务写入一条 restart-recovery 事件（可审计）', async () => {
    const { manager, db } = await setup();
    const expiredId = runningTask(manager, pastIso());
    const aliveId = runningTask(manager, futureIso());
    manager.recoverFromRestart();
    expect(manager.events.countByType('task.restart-recovery')).toBe(2);
    const expiredEvent = manager.events.listRecent(2).find((e) => e.task_id === expiredId);
    expect(expiredEvent?.payload_json).toContain('"expired":true');
    db.close();
  });

  it('恢复后未过期任务仍可正常接受汇报（存疑语义闭环）', async () => {
    const { manager, db } = await setup();
    const aliveId = runningTask(manager, futureIso());
    manager.recoverFromRestart();
    const outcome = manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: aliveId, status: 'completed' }),
      WORKER,
    );
    expect(outcome).toEqual({ accepted: true, reason: 'applied', taskStatus: 'completed' });
    db.close();
  });

  it('重复调用幂等：已判死的任务不再重复处理', async () => {
    const { manager, db } = await setup();
    const expiredId = runningTask(manager, pastIso());
    manager.recoverFromRestart();
    const second = manager.recoverFromRestart();
    expect(second.expiredIds).toEqual([]);
    expect(second.pendingIds).toEqual([]);
    expect(manager.runs.byTask(expiredId)).toHaveLength(1);
    // 第二次调用时已无 running 任务，不写入新事件——幂等的直接证据
    expect(manager.events.countByType('task.restart-recovery')).toBe(1);
    db.close();
  });
});
