/**
 * TaskManager：任务生命周期唯一写入口（DEVELOPMENT_PLAN §6.3）。
 * - 状态转换经 task-state-machine 断言，非法即抛错；
 * - Worker 只能经 applyWorkerReport 间接触发转换（身份 = 派发会话）；
 * - 每次关键动作落审计；多表变更走 withTransaction。
 */
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/connection.js';
import { AuditRepository } from '../database/repository/audit-repository.js';
import { EventRepository } from '../database/repository/event-repository.js';
import { ProjectRepository } from '../database/repository/project-repository.js';
import { TaskRepository } from '../database/repository/task-repository.js';
import { TaskRunRepository } from '../database/repository/task-run-repository.js';
import { ThreadSubscriptionRepository } from '../database/repository/thread-subscription-repository.js';
import { WorkerReportRepository } from '../database/repository/worker-report-repository.js';
import type { WorkerReport } from '../protocols/worker-report.js';
import { targetStatusOf } from '../protocols/worker-report.js';
import { assertTransition } from './task-state-machine.js';
import type { TaskRow, TaskStatus } from '../types/index.js';

/** 操作者身份（审计用）。 */
export interface Actor {
  sessionId?: string;
  role: 'router' | 'worker' | 'system';
}

/** applyWorkerReport 的结构化结果（机器消费值）。 */
export interface ReportOutcome {
  accepted: boolean;
  reason: 'applied' | 'heartbeat' | 'idempotent' | 'resumed' | 'wrong-session' | 'task-missing' | 'invalid-transition' | 'adopted';
  taskStatus: TaskStatus | null;
}

/** 业务错误（调用方按 name 稳定判别）。 */
export class TaskManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskManagerError';
  }
}

/** 依赖环路检测异常。 */
export class DependencyCycleError extends TaskManagerError {
  constructor(readonly cycle: string[]) {
    super(`任务依赖存在环路：${cycle.join(' → ')}`);
    this.name = 'DependencyCycleError';
  }
}

/** 创建任务输入。 */
export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: number;
  parentTaskId?: string;
  dependsOn?: string[];
  maxRetries?: number;
  dueAt?: string;
  /** 来源事件 ID（存在且带 thread_id 时自动订阅其 Thread，供事件直通） */
  sourceEventId?: string;
  /** 任务分类（0.7.2：决定差异化跟进节奏；inspection/investigation/development/maintenance/daily 或自定义） */
  category?: string;
  /** 验收条件（0.7.2 派发契约：注入派发指令，Worker 完成时对照并附证据） */
  acceptance?: string;
}

/** TaskManager 服务（纯逻辑，DSH 交互由上层 AgentController 负责）。 */
export class TaskManager {
  readonly tasks: TaskRepository;
  readonly runs: TaskRunRepository;
  readonly projects: ProjectRepository;
  readonly reports: WorkerReportRepository;
  readonly audit: AuditRepository;
  readonly events: EventRepository;
  readonly threadSubs: ThreadSubscriptionRepository;

  constructor(private readonly db: DatabaseSync) {
    this.tasks = new TaskRepository(db);
    this.runs = new TaskRunRepository(db);
    this.projects = new ProjectRepository(db);
    this.reports = new WorkerReportRepository(db);
    this.audit = new AuditRepository(db);
    this.events = new EventRepository(db);
    this.threadSubs = new ThreadSubscriptionRepository(db);
  }

  /** 创建任务（pending 起步），含依赖登记与环路检测。 */
  createTask(input: CreateTaskInput, actor: Actor): TaskRow {
    if (input.dependsOn && input.dependsOn.length > 0) {
      this.assertNoCycle(input.dependsOn, input.parentTaskId);
    }
    const id = this.tasks.nextTaskId();
    const sourceEvent = input.sourceEventId !== undefined ? this.events.byEventId(input.sourceEventId) : undefined;
    const channelRef = sourceEvent?.channel_ref ?? null;
    withTransaction(this.db, () => {
      this.tasks.create({
        id,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        parentTaskId: input.parentTaskId,
        maxRetries: input.maxRetries,
        dueAt: input.dueAt,
        sourceEventId: input.sourceEventId,
        channelRef: channelRef ?? undefined,
        category: input.category,
        acceptance: input.acceptance,
      });
      for (const dep of input.dependsOn ?? []) {
        this.tasks.addDependency(id, dep);
      }
      if (sourceEvent?.thread_id) {
        this.threadSubs.subscribe(id, sourceEvent.thread_id);
      }
      this.audit.log({
        actorSessionId: actor.sessionId,
        actorRole: actor.role,
        action: 'task.create',
        targetType: 'task',
        targetId: id,
        detailJson: JSON.stringify({ sourceEventId: input.sourceEventId ?? null, threadId: sourceEvent?.thread_id ?? null, channelRef }),
      });
    });
    return this.tasks.byId(id) as TaskRow;
  }

  /** 入队：依赖全部完成后 pending → queued。 */
  enqueue(taskId: string, actor: Actor): TaskRow {
    const task = this.requireTask(taskId);
    const pending = this.tasks.dependenciesOf(taskId).filter((depId) => this.tasks.byId(depId)?.status !== 'completed');
    if (pending.length > 0) {
      throw new TaskManagerError(`前置任务未完成：${pending.join(', ')}`);
    }
    assertTransition(task.status, 'queued');
    withTransaction(this.db, () => {
      this.tasks.updateStatus(taskId, 'queued');
      this.audit.log({ actorSessionId: actor.sessionId, actorRole: actor.role, action: 'task.enqueue', targetType: 'task', targetId: taskId });
    });
    return this.tasks.byId(taskId) as TaskRow;
  }

  /** 派发簿记：queued → running，开启一次执行记录。 */
  markDispatched(taskId: string, sessionId: string, timeoutAt: string | null): TaskRow {
    const task = this.requireTask(taskId);
    assertTransition(task.status, 'running');
    withTransaction(this.db, () => {
      this.tasks.updateStatus(taskId, 'running');
      this.tasks.markDispatched(taskId, sessionId, timeoutAt);
      // attempt 以历史最大号递增（P1-5）：need_human 等收口不增 retry_count，
      // 用 retry_count + 1 会在重派时撞 UNIQUE(task_id, attempt_no)。
      this.runs.start({ taskId, sessionId, attemptNo: this.runs.maxAttemptNo(taskId) + 1 });
      this.audit.log({ actorRole: 'system', action: 'task.dispatch', targetType: 'task', targetId: taskId, detailJson: JSON.stringify({ sessionId }) });
    });
    return this.tasks.byId(taskId) as TaskRow;
  }

  /** 有推进心跳的执行超时顺延（0.7.8，仅 running 任务；推进判定由调用方负责）。 */
  extendTimeout(taskId: string, timeoutAt: string): boolean {
    return this.tasks.extendTimeout(taskId, timeoutAt);
  }

  /**
   * 应用一份 Worker 汇报（协议已在上层校验为规范形态）。
   * 身份规则：仅派发会话（assigned_session_id）可汇报。
   */
  applyWorkerReport(report: WorkerReport, callerSessionId: string): ReportOutcome {
    const task = this.tasks.byId(report.taskId);
    if (!task) {
      return { accepted: false, reason: 'task-missing', taskStatus: null };
    }
    if (task.assigned_session_id !== callerSessionId) {
      this.audit.log({
        actorSessionId: callerSessionId,
        actorRole: 'worker',
        action: 'worker_report.rejected',
        targetType: 'task',
        targetId: report.taskId,
        detailJson: JSON.stringify({ reason: 'wrong-session', assigned: task.assigned_session_id }),
      });
      return { accepted: false, reason: 'wrong-session', taskStatus: task.status };
    }
    const reportId = this.reports.record({
      taskId: report.taskId,
      sessionId: callerSessionId,
      status: report.status,
      progress: report.progress,
      summary: report.summary,
      blockersJson: JSON.stringify(report.blockers),
      needHuman: report.needHuman,
      suggestedActionsJson: JSON.stringify(report.suggestedActions),
      evidence: report.evidence,
    });
    this.tasks.touchReport(report.taskId);
    const target = targetStatusOf(report.status);
    if (task.status === 'need_human' && report.status === 'running') {
      // 决策恢复（P1-6）：need_human 态收到 running 心跳 = 决策已注入、Worker 恢复执行——
      // 显式转回 running（心跳本身无目标态，不经 targetStatusOf）。
      assertTransition(task.status, 'running');
      withTransaction(this.db, () => {
        this.tasks.updateStatus(report.taskId, 'running');
        this.reports.markApplied(reportId);
        this.audit.log({
          actorSessionId: callerSessionId,
          actorRole: 'worker',
          action: 'task.resume',
          targetType: 'task',
          targetId: report.taskId,
        });
      });
      return { accepted: true, reason: 'resumed', taskStatus: 'running' };
    }
    if (target === null) {
      this.reports.markApplied(reportId);
      return { accepted: true, reason: 'heartbeat', taskStatus: task.status };
    }
    if (target === task.status) {
      // 同态汇报幂等放行（P1-6）：need_human 等人工期间 Worker 重申同态（补充选项/更新说明）
      // 只更新汇报留档与心跳时间，不重复走状态机；blocked 同理。
      this.reports.markApplied(reportId);
      return { accepted: true, reason: 'idempotent', taskStatus: task.status };
    }
    if (task.status !== 'running') {
      // 迟到终态汇报收编（FB-1）：watchdog 误判判死后任务回到 queued/failed 待重试态，
      // 此时派发会话发来的终态汇报（completed/need_human/failed）真实有效——收编直达终态，
      // 取消 pending retry。仅在任务非 running 时生效：第二次 run 已开始（running）时
      // 迟到汇报属于上一 run，收编会误伤新 run，仍按 invalid-transition 拒收。
      // need_human 同样开放收编（P1-6）：等待决策期间任务实际已出终局。
      if ((task.status === 'queued' || task.status === 'failed' || task.status === 'need_human') && target !== 'blocked') {
        this.adoptTerminalReport(task, reportId, report, target);
        return { accepted: true, reason: 'adopted', taskStatus: target };
      }
      this.audit.log({
        actorSessionId: callerSessionId,
        actorRole: 'worker',
        action: 'worker_report.rejected',
        targetType: 'task',
        targetId: report.taskId,
        detailJson: JSON.stringify({ reason: 'invalid-transition', from: task.status, to: target }),
      });
      return { accepted: false, reason: 'invalid-transition', taskStatus: task.status };
    }
    assertTransition(task.status, target);
    withTransaction(this.db, () => {
      this.tasks.updateStatus(report.taskId, target);
      const openRun = this.runs.byTask(report.taskId).find((r) => r.ended_at === null);
      if (openRun) {
        this.runs.finish(openRun.id, target === 'completed' ? 'completed' : 'failed', {
          resultSummary: report.summary,
          errorMessage: report.status === 'failed' ? (report.blockers.join('; ') || 'worker 报告失败') : undefined,
        });
      }
      this.reports.markApplied(reportId);
      if (target === 'completed') {
        this.threadSubs.unsubscribeByTask(report.taskId);
      }
      this.refreshProjectHealth(task.project_id, target, report.needHuman);
      this.audit.log({
        actorSessionId: callerSessionId,
        actorRole: 'worker',
        action: 'worker_report.applied',
        targetType: 'task',
        targetId: report.taskId,
        detailJson: JSON.stringify({ status: target }),
      });
    });
    return { accepted: true, reason: 'applied', taskStatus: target };
  }

  /**
   * 重派前收编（FB-3）：检查任务是否存在可收编的迟到终态汇报（applied=0、终态、
   * 来自派发会话、晚于最近一条 run 的开始时间），存在则应用并返回 true。
   * AgentController.dispatchTask 在派发前调用，防止"成果已交付仍整任务重跑"。
   */
  adoptLateReport(taskId: string, actor: Actor): boolean {
    const task = this.tasks.byId(taskId);
    if (!task || task.assigned_session_id === null) return false;
    if (task.status !== 'queued' && task.status !== 'failed') return false;
    const latestRun = this.runs.byTask(taskId)[0];
    if (!latestRun) return false;
    const row = this.reports.findLatestAdoptable(taskId, task.assigned_session_id, latestRun.started_at);
    if (!row) return false;
    let blockers: string[] = [];
    try {
      const parsed = JSON.parse(row.blockers_json) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) blockers = parsed;
    } catch {
      blockers = [];
    }
    const target = targetStatusOf(row.status);
    if (target === null || target === 'blocked') return false;
    this.adoptTerminalReport(task, row.id, {
      workspaceId: '',
      taskId,
      status: row.status,
      progress: row.progress ?? undefined,
      summary: row.summary ?? undefined,
      blockers,
      needHuman: row.need_human === 1,
      suggestedActions: [],
    }, target);
    this.audit.log({
      actorSessionId: actor.sessionId,
      actorRole: actor.role,
      action: 'worker_report.pre-adopted',
      targetType: 'task',
      targetId: taskId,
      detailJson: JSON.stringify({ reportId: row.id, from: task.status, to: target }),
    });
    return true;
  }

  /** 收编事务：直达终态、关闭 open run、标记汇报已应用（历史 run 的 timeout 记录保留不改；from===to 时仅标记应用，不写状态）。 */
  private adoptTerminalReport(task: TaskRow, reportId: number, report: WorkerReport, target: TaskStatus): void {
    const statusChanges = task.status !== target;
    if (statusChanges) {
      assertTransition(task.status, target);
    }
    withTransaction(this.db, () => {
      if (statusChanges) {
        this.tasks.updateStatus(report.taskId, target);
      }
      const openRun = this.runs.byTask(report.taskId).find((r) => r.ended_at === null);
      if (openRun) {
        this.runs.finish(openRun.id, target === 'completed' ? 'completed' : 'failed', {
          resultSummary: report.summary,
          errorMessage: report.status === 'failed' ? (report.blockers.join('; ') || 'worker 报告失败') : undefined,
        });
      }
      this.reports.markApplied(reportId);
      if (target === 'completed') {
        this.threadSubs.unsubscribeByTask(report.taskId);
      }
      this.refreshProjectHealth(task.project_id, target, report.needHuman);
      this.audit.log({
        actorSessionId: task.assigned_session_id ?? undefined,
        actorRole: 'worker',
        action: 'worker_report.adopted',
        targetType: 'task',
        targetId: report.taskId,
        detailJson: JSON.stringify({ from: task.status, to: target, reportId }),
      });
    });
  }

  /** 失败重试：retry_count 未耗尽时 failed → queued。 */
  retry(taskId: string, actor: Actor): TaskRow {
    const task = this.requireTask(taskId);
    if (task.status !== 'failed') {
      throw new TaskManagerError(`仅 failed 任务可重试（当前：${task.status}）`);
    }
    if (task.retry_count >= task.max_retries) {
      throw new TaskManagerError(`重试次数已耗尽（${task.retry_count}/${task.max_retries}）`);
    }
    withTransaction(this.db, () => {
      this.tasks.incrementRetry(taskId);
      this.tasks.updateStatus(taskId, 'queued');
      this.audit.log({ actorSessionId: actor.sessionId, actorRole: actor.role, action: 'task.retry', targetType: 'task', targetId: taskId });
    });
    return this.tasks.byId(taskId) as TaskRow;
  }

  /** 启动超时判定：running 任务在启动窗口内无任何汇报 → failed（open run 以 timeout 收尾）。 */
  markStartupTimeout(taskId: string): boolean {
    const task = this.tasks.byId(taskId);
    if (!task || task.status !== 'running') return false;
    withTransaction(this.db, () => {
      this.tasks.updateStatus(taskId, 'failed');
      const openRun = this.runs.byTask(taskId).find((r) => r.ended_at === null);
      if (openRun) {
        this.runs.finish(openRun.id, 'timeout', { errorMessage: '启动窗口内无 Worker 汇报（Watchdog starting 分类）' });
      }
      this.audit.log({ actorRole: 'system', action: 'task.startup-timeout', targetType: 'task', targetId: taskId });
    });
    this.events.ingest({
      eventId: `watchdog-retry:${taskId}:startup:${Date.now()}`,
      source: 'internal',
      type: 'task.watchdog_retry',
      taskId,
      payloadJson: JSON.stringify({ origin: 'startup' }),
    });
    return true;
  }

  /** 取消：非终态 → canceled，未关闭的执行记录以 canceled 收尾。 */
  cancel(taskId: string, actor: Actor): TaskRow {
    const task = this.requireTask(taskId);
    assertTransition(task.status, 'canceled');
    withTransaction(this.db, () => {
      this.tasks.updateStatus(taskId, 'canceled');
      const openRun = this.runs.byTask(taskId).find((r) => r.ended_at === null);
      if (openRun) {
        this.runs.finish(openRun.id, 'canceled');
      }
      this.threadSubs.unsubscribeByTask(taskId);
      this.audit.log({ actorSessionId: actor.sessionId, actorRole: actor.role, action: 'task.cancel', targetType: 'task', targetId: taskId });
    });
    return this.tasks.byId(taskId) as TaskRow;
  }

  /**
   * 周期超时判定（看门狗专用，FB-7 解耦）：running 且 timeout_at 已过 → failed。
   * 与 recoverFromRestart（启动序列专用，含存疑恢复事件）分离——本方法不写恢复事件，
   * 消除每轮扫描为每个 running 任务堆积 task.restart-recovery 事件的噪音源。
   */
  expireTimedOut(): string[] {
    const nowIso = new Date().toISOString();
    const expiredIds: string[] = [];
    for (const task of this.tasks.list({ status: 'running' })) {
      if (task.timeout_at === null || task.timeout_at >= nowIso) continue;
      withTransaction(this.db, () => {
        this.tasks.updateStatus(task.id, 'failed');
        const openRun = this.runs.byTask(task.id).find((r) => r.ended_at === null);
        if (openRun) {
          this.runs.finish(openRun.id, 'timeout', { errorMessage: '执行超时窗口已过（Watchdog timeout 分类）' });
        }
        this.audit.log({ actorRole: 'system', action: 'task.timeout', targetType: 'task', targetId: task.id });
      });
      this.events.ingest({
        eventId: `watchdog-retry:${task.id}:timeout:${Date.now()}`,
        source: 'internal',
        type: 'task.watchdog_retry',
        taskId: task.id,
        payloadJson: JSON.stringify({ origin: 'timeout' }),
      });
      expiredIds.push(task.id);
    }
    return expiredIds;
  }

  /** Host 重启后存疑恢复的结果（机器消费值）。 */
  recoverFromRestart(): { pendingIds: string[]; expiredIds: string[] } {
    const nowIso = new Date().toISOString();
    const pendingIds: string[] = [];
    const expiredIds: string[] = [];
    for (const task of this.tasks.list({ status: 'running' })) {
      const expired = task.timeout_at !== null && task.timeout_at < nowIso;
      if (expired) {
        withTransaction(this.db, () => {
          this.tasks.updateStatus(task.id, 'failed');
          const openRun = this.runs.byTask(task.id).find((r) => r.ended_at === null);
          if (openRun) {
            this.runs.finish(openRun.id, 'timeout', { errorMessage: 'Host 重启时任务超时窗口已过' });
          }
          this.audit.log({ actorRole: 'system', action: 'task.restart-expired', targetType: 'task', targetId: task.id });
        });
        expiredIds.push(task.id);
      } else {
        pendingIds.push(task.id);
      }
      this.events.ingest({
        eventId: `restart-recovery:${nowIso}:${task.id}`,
        source: 'internal',
        type: 'task.restart-recovery',
        taskId: task.id,
        payloadJson: JSON.stringify({ expired }),
      });
    }
    return { pendingIds, expiredIds };
  }

  private requireTask(taskId: string): TaskRow {
    const task = this.tasks.byId(taskId);
    if (!task) {
      throw new TaskManagerError(`任务不存在：${taskId}`);
    }
    return task;
  }

  /** 依赖环路检测：从新依赖出发 DFS。 */
  private assertNoCycle(dependsOn: string[], parentTaskId?: string): void {
    const visited = new Set<string>();
    const stack: string[] = [];
    const walk = (id: string): void => {
      if (stack.includes(id)) {
        throw new DependencyCycleError([...stack.slice(stack.indexOf(id)), id]);
      }
      if (visited.has(id)) return;
      visited.add(id);
      stack.push(id);
      for (const dep of this.tasks.dependenciesOf(id)) {
        walk(dep);
      }
      stack.pop();
    };
    for (const dep of dependsOn) {
      if (parentTaskId && dep === parentTaskId) {
        throw new DependencyCycleError([parentTaskId, dep]);
      }
      walk(dep);
      if (visited.has(dep) === false) continue;
    }
  }

  /** 汇报驱动的项目健康度刷新（最近一次汇报的语义）。 */
  private refreshProjectHealth(projectId: string, taskStatus: TaskStatus, needHuman: boolean): void {
    if (needHuman || taskStatus === 'blocked' || taskStatus === 'need_human') {
      this.projects.update(projectId, { health: 'blocked' });
    } else if (taskStatus === 'failed') {
      this.projects.update(projectId, { health: 'warning' });
    }
  }
}
