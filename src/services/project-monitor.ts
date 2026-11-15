/**
 * ProjectMonitor：四分类看门狗（方案 §6.6 + ITERATION_PLAN Phase 5-C，借鉴 TianzeLuo）。
 * 1. starting：派发后启动窗口内无任何汇报 → 判 failed（startup-timeout）并按预算重试；
 * 2. timeout：超时窗口已过（recoverFromRestart 语义，原有）→ 重试；
 * 3. need-human：等待人工决策超过升级窗口 → 通知升级（critical）；
 * 4. idle/lost：已汇报过但 Worker 会话空闲过久 → 疑点升级（info）；
 *    会话 Agent 连续两次扫描不存在 → lost（critical）。
 * 定时经全局 setInterval（沙箱 timer 服务需 inject 声明，第一版规避），
 * stop() 显式清理；增强检查依赖（agents/notifier）可选注入，缺省仅运行 1/2 类。
 */
import type { DshAgentAdapter } from '../adapters/dsh-agent.js';
import type { AgentController } from './agent-controller.js';
import type { NotifySeverity } from './notifier.js';
import type { TaskManager } from './task-manager.js';

/** 单次扫描结果（机器消费值）。 */
export interface WatchdogScan {
  expired: string[];
  retried: string[];
  retryExhausted: string[];
  permitsReleased: number;
  startupExpired: string[];
  needHumanEscalated: string[];
  idleSuspects: string[];
  lost: string[];
}

/** 增强检查依赖与阈值（均有缺省）。 */
export interface WatchdogOptions {
  agents?: DshAgentAdapter;
  notify?: (message: string, severity: NotifySeverity) => Promise<boolean>;
  /** 派发后无汇报的启动窗口（默认 2 分钟，验收 6.3-3）。 */
  startingTimeoutMs?: number;
  /** need_human 升级窗口（默认 60s，验收 6.3-4；扫描周期会量化实际触发时点）。 */
  approvalTimeoutMs?: number;
  /** 已汇报任务允许的 Worker 空闲时长（默认 10 分钟）。 */
  idleStaleMs?: number;
}

/** 默认扫描间隔：5 分钟。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STARTING_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 60 * 1000;
const DEFAULT_IDLE_STALE_MS = 10 * 60 * 1000;

export class ProjectMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** lost 双探：上一轮扫描中 Agent 缺失的任务（连续两轮缺失才判 lost）。 */
  private readonly lostSuspects = new Set<string>();
  private readonly startingTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly idleStaleMs: number;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly agentController: AgentController,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly options: WatchdogOptions = {},
  ) {
    this.startingTimeoutMs = options.startingTimeoutMs ?? DEFAULT_STARTING_TIMEOUT_MS;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.idleStaleMs = options.idleStaleMs ?? DEFAULT_IDLE_STALE_MS;
  }

  /** 启动周期扫描。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.intervalMs);
  }

  /** 停止扫描（幂等）。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 扫描一次（四分类）。超时/启动超时判定后：释放并发许可（否则重排后的派发永久等待），
   * 再按重试预算重排。need-human/idle/lost 只升级不代答——Worker 状态交叉验证不足，
   * 合成 completed 汇报会伪造汇报来源（实施修正见 ITERATION_PLAN §6.4）。
   */
  async scanOnce(): Promise<WatchdogScan> {
    const result: WatchdogScan = {
      expired: [], retried: [], retryExhausted: [], permitsReleased: 0,
      startupExpired: [], needHumanEscalated: [], idleSuspects: [], lost: [],
    };
    const recovery = this.taskManager.recoverFromRestart();
    result.expired = recovery.expiredIds;
    for (const taskId of recovery.expiredIds) {
      await this.failAndRetry(taskId, result);
    }
    for (const task of this.taskManager.tasks.list({ status: 'running' })) {
      if (task.last_report_at === null) {
        await this.scanStarting(task.id, result);
      } else {
        await this.scanWorkerLiveness(task.id, task.assigned_session_id, task.last_report_at, result);
      }
    }
    for (const task of this.taskManager.tasks.list({ status: 'need_human' })) {
      const since = Date.parse(task.last_report_at ?? task.updated_at);
      if (Number.isNaN(since) || Date.now() - since < this.approvalTimeoutMs) continue;
      result.needHumanEscalated.push(task.id);
      await this.options.notify?.(`任务 ${task.id} 等待人工决策已超过 ${Math.round(this.approvalTimeoutMs / 1000)}s，请处理`, 'critical');
    }
    return result;
  }

  /** 判死 + 释放许可 + 按预算重排（超时与启动超时共用出口）。 */
  private async failAndRetry(taskId: string, result: WatchdogScan): Promise<void> {
    if (this.agentController.releasePermit(taskId)) {
      result.permitsReleased += 1;
    }
    try {
      this.taskManager.retry(taskId, { role: 'system' });
      result.retried.push(taskId);
    } catch {
      result.retryExhausted.push(taskId);
    }
  }

  /** starting 分类：启动窗口内无汇报 → 判 failed 并重试。 */
  private async scanStarting(taskId: string, result: WatchdogScan): Promise<void> {
    const openRun = this.taskManager.runs.byTask(taskId).find((r) => r.ended_at === null);
    if (!openRun) return;
    const startedAt = Date.parse(openRun.started_at);
    if (Number.isNaN(startedAt) || Date.now() - startedAt < this.startingTimeoutMs) return;
    if (this.taskManager.markStartupTimeout(taskId)) {
      result.startupExpired.push(taskId);
      await this.failAndRetry(taskId, result);
    }
  }

  /** idle/lost 分类：已汇报任务的 Worker 会话活性（需 agents 适配器，缺省跳过）。 */
  private async scanWorkerLiveness(taskId: string, assignedSessionId: string | null, lastReportAt: string, result: WatchdogScan): Promise<void> {
    if (this.options.agents === undefined || assignedSessionId === null) return;
    const sinceReport = Date.now() - Date.parse(lastReportAt);
    if (sinceReport < this.idleStaleMs) {
      this.lostSuspects.delete(taskId);
      return;
    }
    const agent = await this.options.agents.getAgent(assignedSessionId);
    if (agent !== undefined) {
      this.lostSuspects.delete(taskId);
      result.idleSuspects.push(taskId);
      await this.options.notify?.(`任务 ${taskId} 的 Worker 会话空闲已超 ${Math.round(this.idleStaleMs / 60000)} 分钟且无汇报，请核实进展`, 'info');
      return;
    }
    if (this.lostSuspects.has(taskId)) {
      this.lostSuspects.delete(taskId);
      result.lost.push(taskId);
      await this.options.notify?.(`任务 ${taskId} 的 Worker 会话 Agent 连续两轮扫描不存在（lost），请人工核查`, 'critical');
    } else {
      this.lostSuspects.add(taskId);
    }
  }
}
