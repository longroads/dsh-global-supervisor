import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import { TaskManager, TaskManagerError } from '../../src/services/task-manager.js';
import { InvalidTransitionError } from '../../src/services/task-state-machine.js';
import { parseWorkerReport } from '../../src/protocols/worker-report.js';

const ROUTER = { sessionId: 'session-router', role: 'router' as const };
const WORKER = 'session-worker-a';

async function setup(): Promise<{ manager: TaskManager; db: Awaited<ReturnType<typeof openDatabase>> }> {
  const db = await openDatabase(':memory:');
  const manager = new TaskManager(db);
  manager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER });
  return { manager, db };
}

describe('TaskManager 任务生命周期', async () => {
  it('创建 → 入队 → 派发 → 汇报完成 全链路', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: '调研 X' }, ROUTER);
    expect(task.id).toMatch(/^task-\d{8}-\d{3}$/);
    expect(task.status).toBe('pending');

    const queued = manager.enqueue(task.id, ROUTER);
    expect(queued.status).toBe('queued');

    const running = manager.markDispatched(task.id, WORKER, null);
    expect(running.status).toBe('running');
    expect(running.assigned_session_id).toBe(WORKER);
    expect(manager.runs.byTask(task.id)).toHaveLength(1);

    const outcome = manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'completed', summary: '完成' }),
      WORKER,
    );
    expect(outcome).toEqual({ accepted: true, reason: 'applied', taskStatus: 'completed' });
    expect(manager.tasks.byId(task.id)?.status).toBe('completed');
    expect(manager.runs.byTask(task.id)[0]?.outcome).toBe('completed');
    expect(manager.reports.latestOf(task.id)?.applied).toBe(1);
    expect(manager.audit.byTarget('task', task.id).length).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it('心跳汇报不转移状态，仅刷新汇报时间', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    const outcome = manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'running', progress: 40 }),
      WORKER,
    );
    expect(outcome.reason).toBe('heartbeat');
    expect(manager.tasks.byId(task.id)?.status).toBe('running');
    expect(manager.tasks.byId(task.id)?.last_report_at).not.toBeNull();
    db.close();
  });

  it('非派发会话汇报被拒（wrong-session）并留审计', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    const outcome = manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'completed' }),
      'session-intruder',
    );
    expect(outcome).toEqual({ accepted: false, reason: 'wrong-session', taskStatus: 'running' });
    expect(manager.tasks.byId(task.id)?.status).toBe('running');
    const rejects = manager.audit.byTarget('task', task.id).filter((a) => a.action === 'worker_report.rejected');
    expect(rejects).toHaveLength(1);
    db.close();
  });

  it('任务不存在与状态不符的汇报结果', async () => {
    const { manager, db } = await setup();
    expect(manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: 'task-missing', status: 'completed' }),
      WORKER,
    )).toEqual({ accepted: false, reason: 'task-missing', taskStatus: null });

    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'completed' }),
      WORKER,
    );
    // 已完成后再次汇报 → invalid-transition（状态机封闭）
    const again = manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'failed' }),
      WORKER,
    );
    expect(again.reason).toBe('invalid-transition');
    db.close();
  });

  it('blocked 汇报联动项目健康度', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'blocked', blockers: ['依赖缺失'] }),
      WORKER,
    );
    expect(manager.tasks.byId(task.id)?.status).toBe('blocked');
    expect(manager.projects.byId('proj-1')?.health).toBe('blocked');
    db.close();
  });

  it('失败重试与重试耗尽', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', maxRetries: 1 }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'failed' }),
      WORKER,
    );
    expect(manager.tasks.byId(task.id)?.status).toBe('failed');

    const retried = manager.retry(task.id, ROUTER);
    expect(retried.status).toBe('queued');
    expect(retried.retry_count).toBe(1);

    // 第二次失败后重试耗尽
    manager.markDispatched(task.id, WORKER, null);
    manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'failed' }),
      WORKER,
    );
    expect(() => manager.retry(task.id, ROUTER)).toThrow(TaskManagerError);
    expect(manager.runs.byTask(task.id)).toHaveLength(2);
    expect(manager.runs.byTask(task.id)[1]?.attempt_no).toBe(2);
    db.close();
  });

  it('取消：running → canceled，执行记录以 canceled 收尾；终态再取消抛状态机错误', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    const canceled = manager.cancel(task.id, ROUTER);
    expect(canceled.status).toBe('canceled');
    expect(manager.runs.byTask(task.id)[0]?.outcome).toBe('canceled');
    expect(() => manager.cancel(task.id, ROUTER)).toThrow(InvalidTransitionError);
    db.close();
  });

  it('依赖未完成禁止入队，完成后放行', async () => {
    const { manager, db } = await setup();
    const first = manager.createTask({ projectId: 'proj-1', title: '前置' }, ROUTER);
    const second = manager.createTask({ projectId: 'proj-1', title: '后继', dependsOn: [first.id] }, ROUTER);
    expect(() => manager.enqueue(second.id, ROUTER)).toThrow(TaskManagerError);

    manager.enqueue(first.id, ROUTER);
    manager.markDispatched(first.id, WORKER, null);
    manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: first.id, status: 'completed' }),
      WORKER,
    );
    expect(manager.enqueue(second.id, ROUTER).status).toBe('queued');
    db.close();
  });

  it('依赖含父任务时抛环路错误', async () => {
    const { manager, db } = await setup();
    const parent = manager.createTask({ projectId: 'proj-1', title: '父' }, ROUTER);
    expect(() =>
      manager.createTask({ projectId: 'proj-1', title: '子', parentTaskId: parent.id, dependsOn: [parent.id] }, ROUTER),
    ).toThrow(TaskManagerError);
    db.close();
  });
});

describe('TaskManager Thread 订阅生命周期', () => {
  it('来源事件带 thread_id：创建任务自动订阅其 Thread', async () => {
    const { manager, db } = await setup();
    manager.events.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-1' }, ROUTER);
    expect(task.source_event_id).toBe('wh-1');
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual(['th-1']);
    db.close();
  });

  it('来源事件无 thread_id：任务照常创建但不订阅', async () => {
    const { manager, db } = await setup();
    manager.events.ingest({ eventId: 'wh-2', source: 'webhook', type: 'issue.opened' });
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-2' }, ROUTER);
    expect(task.status).toBe('pending');
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual([]);
    db.close();
  });

  it('来源事件不存在：任务照常创建且不订阅（不报错）', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-missing' }, ROUTER);
    expect(task.status).toBe('pending');
    expect(task.source_event_id).toBe('wh-missing');
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual([]);
    db.close();
  });

  it('任务完成：Thread 订阅自动退订', async () => {
    const { manager, db } = await setup();
    manager.events.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-1' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    const outcome = manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'completed' }),
      WORKER,
    );
    expect(outcome.taskStatus).toBe('completed');
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual([]);
    db.close();
  });

  it('任务失败：订阅保留（failed 可重试，重试后仍跟随同一 Thread）', async () => {
    const { manager, db } = await setup();
    manager.events.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-1' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    manager.applyWorkerReport(
      parseWorkerReport({ workspace_id: 'ws-1', task_id: task.id, status: 'failed' }),
      WORKER,
    );
    expect(manager.tasks.byId(task.id)?.status).toBe('failed');
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual(['th-1']);
    manager.retry(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual(['th-1']);
    db.close();
  });

  it('任务取消：Thread 订阅自动退订', async () => {
    const { manager, db } = await setup();
    manager.events.ingest({ eventId: 'wh-1', source: 'webhook', type: 'issue.opened', threadId: 'th-1' });
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-1' }, ROUTER);
    manager.cancel(task.id, ROUTER);
    expect(manager.tasks.byId(task.id)?.status).toBe('canceled');
    expect(manager.threadSubs.threadsOfTask(task.id)).toEqual([]);
    db.close();
  });
});

describe('TaskManager Channel 追踪', () => {
  it('来源事件带 channel_ref：任务继承信道标识（完成时经该信道回复）', async () => {
    const { manager, db } = await setup();
    manager.events.ingest({ eventId: 'wh-1', source: 'im', type: 'issue.opened', channelRef: 'im:feishu:chat-1' });
    const task = manager.createTask({ projectId: 'proj-1', title: 'T', sourceEventId: 'wh-1' }, ROUTER);
    expect(task.channel_ref).toBe('im:feishu:chat-1');
    db.close();
  });

  it('无来源事件：任务 channel_ref 为 null', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    expect(task.channel_ref).toBeNull();
    db.close();
  });
});

describe('TaskManager 启动超时判定', () => {
  it('running 任务判 failed（startup-timeout），open run 以 timeout 收尾并留审计', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    manager.enqueue(task.id, ROUTER);
    manager.markDispatched(task.id, WORKER, null);
    expect(manager.markStartupTimeout(task.id)).toBe(true);
    expect(manager.tasks.byId(task.id)?.status).toBe('failed');
    expect(manager.runs.byTask(task.id).some((r) => r.outcome === 'timeout')).toBe(true);
    expect(manager.audit.byTarget('task', task.id).some((a) => a.action === 'task.startup-timeout')).toBe(true);
    db.close();
  });

  it('非 running 任务不判定（幂等安全）', async () => {
    const { manager, db } = await setup();
    const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
    expect(manager.markStartupTimeout(task.id)).toBe(false);
    expect(manager.tasks.byId(task.id)?.status).toBe('pending');
    db.close();
  });
});
