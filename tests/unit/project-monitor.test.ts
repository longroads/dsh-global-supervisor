import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openDatabase } from '../../src/database/connection.js';
import { DshAgentAdapter } from '../../src/adapters/dsh-agent.js';
import { AgentController } from '../../src/services/agent-controller.js';
import { ProjectMonitor } from '../../src/services/project-monitor.js';
import type { WatchdogOptions } from '../../src/services/project-monitor.js';
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

/** fake agents 服务：agentPresent=false 时 get 返回 undefined（会话冷/Agent 不存在）；status 可配置；steer 调用被捕获。 */
function fakeAgentService(agentPresent: boolean, status: 'idle' | 'running' = 'idle') {
  const steers: string[] = [];
  const agent = {
    id: WORKER,
    status,
    options: {},
    followup: () => undefined,
    steer: (message: unknown) => {
      const content = (message as { content?: Array<{ text?: string }> }).content;
      steers.push(content?.[0]?.text ?? '');
    },
    cancel: () => undefined,
    whenIdle: async () => undefined,
  };
  return {
    steers,
    get: () => (agentPresent ? agent : undefined),
    list: () => [],
    resume: async () => ({ agent }),
  };
}

interface Notice {
  message: string;
  severity: string;
}

/** KV 配置替身（Map 支撑的 WatchdogSettingSource）。 */
function fakeSettings(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  return {
    getJson: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
    set: (key: string, value: number) => store.set(key, value),
  };
}

async function setup(monitorOptions: WatchdogOptions = {}, agentPresent = false, agentStatus: 'idle' | 'running' = 'idle'): Promise<{ monitor: ProjectMonitor; manager: TaskManager; controller: AgentController; db: Awaited<ReturnType<typeof openDatabase>>; steers: string[] }> {
  const db = await openDatabase(':memory:');
  // 固定 fake 实例：ctx.get('agents') 每次返回同一服务，steers 捕获才可靠
  const agentsService = fakeAgentService(agentPresent, agentStatus);
  const fakeCtx = { get: (name: string) => (name === 'agents' ? agentsService : {}) } as unknown as Context;
  const manager = new TaskManager(db);
  manager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', workerSessionId: WORKER });
  const adapter = new DshAgentAdapter(fakeCtx);
  const controller = new AgentController(adapter, manager, db);
  const monitor = new ProjectMonitor(manager, controller, undefined, { agents: adapter, ...monitorOptions });
  return { monitor, manager, controller, db, steers: agentsService.steers };
}

function runningTask(manager: TaskManager, timeoutAt: string | null): string {
  const task = manager.createTask({ projectId: 'proj-1', title: 'T' }, ROUTER);
  manager.enqueue(task.id, ROUTER);
  manager.markDispatched(task.id, WORKER, timeoutAt);
  return task.id;
}

describe('ProjectMonitor 超时看门狗', () => {
  it('无超时任务时扫描返回空结果', async () => {
    const { monitor, manager } = await setup({ startingTimeoutMs: 60 * 60 * 1000 });
    runningTask(manager, futureIso());
    runningTask(manager, null);
    const scan = await monitor.scanOnce();
    expect(scan.expired).toEqual([]);
    expect(scan.retried).toEqual([]);
    expect(scan.startupExpired).toEqual([]);
  });

  it('超时任务判 failed 并按预算重排（expired → retried → queued）', async () => {
    const { monitor, manager } = await setup();
    const taskId = runningTask(manager, pastIso());
    const scan = await monitor.scanOnce();
    expect(scan.expired).toEqual([taskId]);
    expect(scan.retried).toEqual([taskId]);
    expect(manager.tasks.byId(taskId)?.status).toBe('queued');
    expect(manager.runs.byTask(taskId)[0]?.outcome).toBe('timeout');
  });

  it('重试预算耗尽的任务进 retryExhausted（保持 failed）', async () => {
    const { monitor, manager } = await setup();
    const taskId = runningTask(manager, pastIso());
    let scan = await monitor.scanOnce();
    expect(scan.retried).toEqual([taskId]);
    manager.markDispatched(taskId, WORKER, pastIso());
    scan = await monitor.scanOnce();
    expect(scan.retried).toEqual([taskId]);
    manager.markDispatched(taskId, WORKER, pastIso());
    scan = await monitor.scanOnce();
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

    const scan = await monitor.scanOnce();
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

describe('ProjectMonitor 四分类增强（Phase 5-C）', () => {
  it('starting：启动窗口内无汇报 → 判 failed 并重试（验收 6.3-3）', async () => {
    const { monitor, manager, db } = await setup({ startingTimeoutMs: 1_000 });
    const taskId = runningTask(manager, futureIso());
    db.prepare('UPDATE task_runs SET started_at = ? WHERE task_id = ?').run(pastIso(), taskId);
    const scan = await monitor.scanOnce();
    expect(scan.startupExpired).toEqual([taskId]);
    expect(scan.retried).toEqual([taskId]);
    expect(manager.tasks.byId(taskId)?.status).toBe('queued');
    expect(manager.audit.byTarget('task', taskId).some((a) => a.action === 'task.startup-timeout')).toBe(true);
  });

  it('need_human 超过升级窗口 → critical 通知（验收 6.3-4）', async () => {
    const notified: Notice[] = [];
    const { monitor, manager, db } = await setup({
      approvalTimeoutMs: 1_000,
      startingTimeoutMs: 60 * 60 * 1000,
      notify: async (message, severity) => {
        notified.push({ message, severity });
        return true;
      },
    });
    const taskId = runningTask(manager, futureIso());
    manager.applyWorkerReport(parseWorkerReport({ workspace_id: 'ws-1', task_id: taskId, status: 'need_human', need_human: true, summary: '等确认' }), WORKER);
    db.prepare('UPDATE tasks SET last_report_at = ? WHERE id = ?').run(pastIso(), taskId);
    const scan = await monitor.scanOnce();
    expect(scan.needHumanEscalated).toEqual([taskId]);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.severity).toBe('critical');
    expect(notified[0]?.message).toContain(taskId);
  });

  it('idle：Worker 会话空闲过久且无汇报 → 先催告心跳再 warning 升级（FB-11 两段式；推送隔离下验证）', async () => {
    const notified: Notice[] = [];
    const { monitor, manager, db, steers } = await setup(
      {
        idleStaleMs: 1_000,
        startingTimeoutMs: 60 * 60 * 1000,
        settings: fakeSettings({ 'watchdog.progressPushIntervalMs': 0 }),
        notify: async (message, severity) => {
          notified.push({ message, severity });
          return true;
        },
      },
      true,
    );
    const taskId = runningTask(manager, futureIso());
    manager.applyWorkerReport(parseWorkerReport({ workspace_id: 'ws-1', task_id: taskId, status: 'running', progress: 50 }), WORKER);
    db.prepare('UPDATE tasks SET last_report_at = ? WHERE id = ?').run(pastIso(), taskId);
    const scan = await monitor.scanOnce();
    expect(scan.idleSuspects).toEqual([taskId]);
    expect(scan.lost).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.severity).toBe('warning');
    expect(notified[0]?.message).toContain('已催告心跳');
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain('心跳催告');
    expect(manager.tasks.byId(taskId)?.status).toBe('running');
  });

  it('lost：Agent 连续两轮扫描不存在才判定（双探），critical 通知（推送隔离下验证）', async () => {
    const notified: Notice[] = [];
    const { monitor, manager, db } = await setup({
      idleStaleMs: 1_000,
      startingTimeoutMs: 60 * 60 * 1000,
      settings: fakeSettings({ 'watchdog.progressPushIntervalMs': 0 }),
      notify: async (message, severity) => {
        notified.push({ message, severity });
        return true;
      },
    });
    const taskId = runningTask(manager, futureIso());
    manager.applyWorkerReport(parseWorkerReport({ workspace_id: 'ws-1', task_id: taskId, status: 'running', progress: 50 }), WORKER);
    db.prepare('UPDATE tasks SET last_report_at = ? WHERE id = ?').run(pastIso(), taskId);
    const first = await monitor.scanOnce();
    expect(first.lost).toEqual([]);
    expect(notified).toHaveLength(0);
    const second = await monitor.scanOnce();
    expect(second.lost).toEqual([taskId]);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.severity).toBe('critical');
  });
});

describe('ProjectMonitor 看门狗修复（FB-2/FB-4/FB-7）', () => {
  it('活跃宽限：启动窗口已过但 Worker Agent 仍在执行 → 不判死（startupGrace），交执行超时兜底', async () => {
    const { monitor, manager, db } = await setup({ startingTimeoutMs: 1_000 }, true, 'running');
    const taskId = runningTask(manager, futureIso());
    db.prepare('UPDATE task_runs SET started_at = ? WHERE task_id = ?').run(pastIso(), taskId);
    const scan = await monitor.scanOnce();
    expect(scan.startupGrace).toEqual([taskId]);
    expect(scan.startupExpired).toEqual([]);
    expect(manager.tasks.byId(taskId)?.status).toBe('running');
    db.close();
  });

  it('KV 配置覆盖缺省：watchdog.startingTimeoutMs 动态生效（下轮扫描无需重建）', async () => {
    const settings = fakeSettings({ 'watchdog.startingTimeoutMs': 60 * 60 * 1000 });
    const { monitor, manager, db } = await setup({ startingTimeoutMs: 1_000, settings });
    const taskId = runningTask(manager, futureIso());
    db.prepare('UPDATE task_runs SET started_at = ? WHERE task_id = ?').run(pastIso(), taskId);
    const scan = await monitor.scanOnce();
    expect(scan.startupExpired).toEqual([]);
    expect(manager.tasks.byId(taskId)?.status).toBe('running');
    // 改小 KV 值 → 下一轮判定生效
    settings.set('watchdog.startingTimeoutMs', 1_000);
    const second = await monitor.scanOnce();
    expect(second.startupExpired).toEqual([taskId]);
    db.close();
  });

  it('周期超时与 restart-recovery 解耦（FB-7）：scanOnce 不再写 task.restart-recovery 事件，审计为 task.timeout', async () => {
    const { monitor, manager, db } = await setup();
    const taskId = runningTask(manager, pastIso());
    const scan = await monitor.scanOnce();
    expect(scan.expired).toEqual([taskId]);
    const events = db.prepare("SELECT * FROM events WHERE type = 'task.restart-recovery'").all();
    expect(events).toHaveLength(0);
    expect(manager.audit.byTarget('task', taskId).some((a) => a.action === 'task.timeout')).toBe(true);
    db.close();
  });

  it('FB-7 复现：任务 cancel 后继续扫描，不再出现 restart-recovery 事件（反馈实录场景）', async () => {
    const { monitor, manager, db } = await setup();
    const taskId = runningTask(manager, futureIso());
    manager.cancel(taskId, { sessionId: 'session-router', role: 'router' });
    await monitor.scanOnce();
    await monitor.scanOnce();
    const events = db.prepare("SELECT * FROM events WHERE type = 'task.restart-recovery'").all();
    expect(events).toHaveLength(0);
    expect(manager.tasks.byId(taskId)?.status).toBe('canceled');
    db.close();
  });

  it('FB-11 催告去抖：idleStale 窗口内第二轮不重复 steer，告警文案标注去抖中', async () => {
    const notified: Notice[] = [];
    const { monitor, manager, db, steers } = await setup(
      {
        idleStaleMs: 60 * 60 * 1000,
        startingTimeoutMs: 60 * 60 * 1000,
        settings: fakeSettings({ 'watchdog.progressPushIntervalMs': 0 }),
        notify: async (message, severity) => {
          notified.push({ message, severity });
          return true;
        },
      },
      true,
    );
    const taskId = runningTask(manager, futureIso());
    manager.applyWorkerReport(parseWorkerReport({ workspace_id: 'ws-1', task_id: taskId, status: 'running', progress: 50 }), WORKER);
    // 回拨 2 小时（超过 1 小时的 idleStale 窗口触发超龄；去抖窗口 = idleStale = 1 小时，两轮扫描都在窗口内）
    db.prepare('UPDATE tasks SET last_report_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), taskId);
    await monitor.scanOnce();
    await monitor.scanOnce();
    expect(steers).toHaveLength(1);
    expect(notified).toHaveLength(2);
    expect(notified[0]?.message).toContain('已催告心跳');
    expect(notified[1]?.message).toContain('去抖');
  });

  it('FB-12/13 零 LLM 快照与巡检摘要：每轮扫描落 progress_snapshot 与 patrol.summary 事件', async () => {
    const { monitor, manager, db } = await setup({
      startingTimeoutMs: 60 * 60 * 1000,
      settings: fakeSettings({ 'watchdog.progressPushIntervalMs': 0 }),
    });
    runningTask(manager, futureIso());
    await monitor.scanOnce();
    const snapshots = db.prepare("SELECT * FROM events WHERE type = 'task.progress_snapshot'").all() as Array<{ payload_json: string }>;
    expect(snapshots).toHaveLength(1);
    const snapshot = JSON.parse(snapshots[0]?.payload_json ?? '{}') as { agentStatus?: string; lastReportAgeSec?: number | null };
    expect(snapshot.agentStatus).toBe('absent');
    expect(snapshot.lastReportAgeSec).toBeNull();
    const patrol = db.prepare("SELECT * FROM events WHERE type = 'patrol.summary'").all() as Array<{ payload_json: string }>;
    expect(patrol).toHaveLength(1);
    expect((JSON.parse(patrol[0]?.payload_json ?? '{}') as { runningCount?: number }).runningCount).toBe(1);
  });

  it('FB-12 进度推送：首轮即推汇总 info 且含任务 ID；间隔未到不重复；0 关闭', async () => {
    const notified: Notice[] = [];
    const on = await setup({
      startingTimeoutMs: 60 * 60 * 1000,
      notify: async (message, severity) => {
        notified.push({ message, severity });
        return true;
      },
    });
    const taskId = runningTask(on.manager, futureIso());
    await on.monitor.scanOnce();
    const pushes = notified.filter((n) => n.severity === 'info' && n.message.includes('运行中任务'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.message).toContain(taskId);
    await on.monitor.scanOnce();
    expect(notified.filter((n) => n.severity === 'info' && n.message.includes('运行中任务'))).toHaveLength(1);

    const offNotified: Notice[] = [];
    const off = await setup({
      startingTimeoutMs: 60 * 60 * 1000,
      settings: fakeSettings({ 'watchdog.progressPushIntervalMs': 0 }),
      notify: async (message, severity) => {
        offNotified.push({ message, severity });
        return true;
      },
    });
    runningTask(off.manager, futureIso());
    await off.monitor.scanOnce();
    expect(offNotified).toHaveLength(0);
  });

  it('判死重试发 warning 通知、重试预算耗尽发 critical 通知（FB-4）', async () => {
    const notified: Notice[] = [];
    const { monitor, manager } = await setup({
      startingTimeoutMs: 1_000,
      notify: async (message, severity) => {
        notified.push({ message, severity });
        return true;
      },
    });
    const taskId = runningTask(manager, pastIso());
    await monitor.scanOnce();
    expect(notified).toHaveLength(1);
    expect(notified[0]?.severity).toBe('warning');
    expect(notified[0]?.message).toContain(taskId);
    // 重试 → 再派发 → 再超时 → 预算耗尽（max_retries 默认 2）
    manager.markDispatched(taskId, WORKER, pastIso());
    await monitor.scanOnce();
    manager.markDispatched(taskId, WORKER, pastIso());
    await monitor.scanOnce();
    const criticals = notified.filter((n) => n.severity === 'critical');
    expect(criticals).toHaveLength(1);
    expect(criticals[0]?.message).toContain(taskId);
  });
});
