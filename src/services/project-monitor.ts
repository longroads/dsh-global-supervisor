/**
 * ProjectMonitor：四分类看门狗（方案 §6.6 + ITERATION_PLAN Phase 5-C，借鉴 TianzeLuo）。
 * 1. starting：派发后启动窗口内无任何汇报 → 判 failed（startup-timeout）并按预算重试；
 *    Worker Agent 仍在执行（status=running）时宽限本轮——真死由 timeout 分类的执行超时窗口兜底（FB-2）；
 * 2. timeout：执行超时窗口已过 → 重试（周期扫描，与 restart-recovery 启动序列解耦，FB-7）；
 * 3. need-human：等待人工决策超过升级窗口 → 通知升级（critical）；
 * 4. idle/lost：已汇报过但 Worker 会话空闲过久 → 疑点升级（info）；
 *    会话 Agent 连续两次扫描不存在 → lost（critical）。
 * 超时阈值经 plugin_settings KV 动态配置（supervisor_watchdog_config 工具），构造参数为缺省值。
 * 判死重试/预算耗尽均发通知（FB-4 闭环通知——看门狗动作不再静默）。
 * 定时经全局 setInterval（沙箱 timer 服务需 inject 声明，第一版规避），stop() 显式清理。
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
  /** 活跃宽限跳过的任务（Agent 仍在执行，等待其汇报或执行超时兜底）。 */
  startupGrace: string[];
  needHumanEscalated: string[];
  idleSuspects: string[];
  lost: string[];
}

/** KV 配置读取面（PluginSettingRepository 的最小面，便于测试替身）。 */
export interface WatchdogSettingSource {
  getJson<T>(key: string): T | undefined;
}

/** 看门狗 KV 配置键（supervisor_watchdog_config 工具与本服务共用；值为毫秒整数，progress 为 0=关）。 */
export const WATCHDOG_SETTING_KEYS = {
  startingTimeoutMs: 'watchdog.startingTimeoutMs',
  approvalTimeoutMs: 'watchdog.approvalTimeoutMs',
  idleStaleMs: 'watchdog.idleStaleMs',
  scanIntervalMs: 'watchdog.scanIntervalMs',
  heartbeatIntervalMs: 'watchdog.heartbeatIntervalMs',
  progressPushIntervalMs: 'watchdog.progressPushIntervalMs',
  categoryOverrides: 'watchdog.categoryOverrides',
} as const;

/** 分类级节奏覆盖项（0.7.2：按任务分类差异化跟进；缺省键回落全局值）。 */
export interface CategoryOverride {
  startingTimeoutMs?: number;
  idleStaleMs?: number;
  heartbeatIntervalMs?: number;
}

/** 读取分类覆盖表（畸形值整体忽略——覆盖配置坏行不阻断全局节奏）。 */
export function readCategoryOverrides(settings: WatchdogSettingSource | undefined): Record<string, CategoryOverride> {
  const raw = settings?.getJson<Record<string, CategoryOverride>>(WATCHDOG_SETTING_KEYS.categoryOverrides);
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
}

/** 增强检查依赖与缺省阈值。 */
export interface WatchdogOptions {
  agents?: DshAgentAdapter;
  notify?: (message: string, severity: NotifySeverity) => Promise<boolean>;
  /** 派发后无汇报的启动窗口缺省（10 分钟；生产反馈 FB-2：长上下文 Worker 首报 7 分钟属正常）。 */
  startingTimeoutMs?: number;
  /** need_human 升级窗口缺省（60s；扫描周期会量化实际触发时点）。 */
  approvalTimeoutMs?: number;
  /** 已汇报任务允许的 Worker 空闲时长缺省（10 分钟）。 */
  idleStaleMs?: number;
  /** KV 配置源（运行时覆盖缺省；supervisor_watchdog_config 写入）。 */
  settings?: WatchdogSettingSource;
}

/** 默认扫描间隔：5 分钟（可经 watchdog.scanIntervalMs KV 调整；各超时窗口的实际触发时点被扫描周期量化）。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STARTING_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 60 * 1000;
const DEFAULT_IDLE_STALE_MS = 10 * 60 * 1000;
/** 心跳契约缺省间隔（FB-11）：必须小于 idleStaleMs，否则契约必然违约。 */
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
/** 进度推送缺省间隔（FB-12）：15 分钟；0 = 关闭。 */
const DEFAULT_PROGRESS_PUSH_MS = 15 * 60 * 1000;

export class ProjectMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 当前定时器生效的间隔（KV 变更后重排比对用）。 */
  private armedIntervalMs = 0;
  /** lost 双探：上一轮扫描中 Agent 缺失的任务（连续两轮缺失才判 lost）。 */
  private readonly lostSuspects = new Set<string>();
  /** 心跳催告去抖：key = taskId，value = 上次催告毫秒时间戳（窗口 = idleStaleMs）。 */
  private readonly nudgedAt = new Map<string, number>();
  /** 上次进度推送毫秒时间戳（0 = 尚未推送过，首轮即推）。 */
  private progressPushedAt = 0;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly agentController: AgentController,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    private readonly options: WatchdogOptions = {},
  ) {}

  /** 启动窗口（KV 覆盖缺省；非法值回退缺省）。 */
  private startingTimeoutMs(): number {
    return positiveOverride(this.options.settings?.getJson<number>(WATCHDOG_SETTING_KEYS.startingTimeoutMs), this.options.startingTimeoutMs ?? DEFAULT_STARTING_TIMEOUT_MS);
  }

  /** need_human 升级窗口（KV 覆盖缺省）。 */
  private approvalTimeoutMs(): number {
    return positiveOverride(this.options.settings?.getJson<number>(WATCHDOG_SETTING_KEYS.approvalTimeoutMs), this.options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
  }

  /** Worker 空闲阈值（KV 覆盖缺省）。 */
  private idleStaleMs(): number {
    return positiveOverride(this.options.settings?.getJson<number>(WATCHDOG_SETTING_KEYS.idleStaleMs), this.options.idleStaleMs ?? DEFAULT_IDLE_STALE_MS);
  }

  /** 扫描间隔（KV 覆盖构造缺省）。 */
  scanIntervalMs(): number {
    return positiveOverride(this.options.settings?.getJson<number>(WATCHDOG_SETTING_KEYS.scanIntervalMs), this.intervalMs);
  }

  /** 心跳契约间隔（FB-11；派发指令注入与催告文案共用）。 */
  heartbeatIntervalMs(): number {
    return positiveOverride(this.options.settings?.getJson<number>(WATCHDOG_SETTING_KEYS.heartbeatIntervalMs), DEFAULT_HEARTBEAT_MS);
  }

  /** 进度推送间隔（FB-12；0 = 关闭，负值/非法回退缺省）。 */
  progressPushIntervalMs(): number {
    const configured = this.options.settings?.getJson<number>(WATCHDOG_SETTING_KEYS.progressPushIntervalMs);
    return typeof configured === 'number' && configured === 0 ? 0 : positiveOverride(configured, DEFAULT_PROGRESS_PUSH_MS);
  }

  /** 当前生效的全部看门狗配置（supervisor_watchdog_config 查询与测试共用）。 */
  effectiveConfig(): { startingTimeoutMs: number; approvalTimeoutMs: number; idleStaleMs: number; scanIntervalMs: number; heartbeatIntervalMs: number; progressPushIntervalMs: number } {
    return {
      startingTimeoutMs: this.startingTimeoutMs(),
      approvalTimeoutMs: this.approvalTimeoutMs(),
      idleStaleMs: this.idleStaleMs(),
      scanIntervalMs: this.scanIntervalMs(),
      heartbeatIntervalMs: this.heartbeatIntervalMs(),
      progressPushIntervalMs: this.progressPushIntervalMs(),
    };
  }

  /** 启动周期扫描。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.armTimer();
  }

  /** 停止扫描（幂等）。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 装载定时器（记录生效间隔，供 tick 后比对 KV 变更重排）。 */
  private armTimer(): void {
    const interval = this.scanIntervalMs();
    this.armedIntervalMs = interval;
    this.timer = setInterval(() => {
      void this.scanOnce().finally(() => this.rearmIfIntervalChanged());
    }, interval);
  }

  /** KV 修改扫描间隔后在下一轮扫描结束时重排定时器（本轮不受影响）。 */
  private rearmIfIntervalChanged(): void {
    if (this.timer === undefined) return;
    if (this.scanIntervalMs() === this.armedIntervalMs) return;
    clearInterval(this.timer);
    this.armTimer();
  }

  /**
   * 扫描一次（四分类）。超时/启动超时判定后：释放并发许可（否则重排后的派发永久等待），
   * 再按重试预算重排，并通知 Router（判死重试 warning、预算耗尽 critical——FB-4）。
   * need-human/idle/lost 只升级不代答——Worker 状态交叉验证不足，
   * 合成 completed 汇报会伪造汇报来源（实施修正见 ITERATION_PLAN §6.4）。
   */
  async scanOnce(): Promise<WatchdogScan> {
    const result: WatchdogScan = {
      expired: [], retried: [], retryExhausted: [], permitsReleased: 0,
      startupExpired: [], startupGrace: [], needHumanEscalated: [], idleSuspects: [], lost: [],
    };
    result.expired = this.taskManager.expireTimedOut();
    for (const taskId of result.expired) {
      await this.failAndRetry(taskId, 'timeout', result);
    }
    for (const task of this.taskManager.tasks.list({ status: 'running' })) {
      if (task.last_report_at === null) {
        await this.scanStarting(task.id, task.assigned_session_id, task.category, result);
      } else {
        await this.scanWorkerLiveness(task.id, task.assigned_session_id, task.last_report_at, task.category, result);
      }
    }
    for (const task of this.taskManager.tasks.list({ status: 'need_human' })) {
      const since = Date.parse(task.last_report_at ?? task.updated_at);
      if (Number.isNaN(since) || Date.now() - since < this.approvalTimeoutMs()) continue;
      result.needHumanEscalated.push(task.id);
      await this.options.notify?.(`任务 ${task.id} 等待人工决策已超过 ${Math.round(this.approvalTimeoutMs() / 1000)}s，请处理`, 'critical');
    }
    // 运行期可见性（FB-12/13，零 LLM）：每轮产出 running 任务进度快照与巡检摘要事件；
    // 推送间隔到点且有运行中任务时向 Router/IM 汇总一条
    const snapshots = await this.recordProgressSnapshots();
    this.recordPatrolSummary(result, snapshots);
    await this.pushProgressIfDue(snapshots);
    return result;
  }

  /** 判死 + 释放许可 + 按重试预算重排 + 通知（超时与启动超时共用出口；重试排队中的迟到终态汇报由收编机制兜底）。 */
  private async failAndRetry(taskId: string, origin: 'timeout' | 'startup', result: WatchdogScan): Promise<void> {
    if (this.agentController.releasePermit(taskId)) {
      result.permitsReleased += 1;
    }
    try {
      this.taskManager.retry(taskId, { role: 'system' });
      result.retried.push(taskId);
      await this.options.notify?.(`任务 ${taskId} 被 watchdog 判定${origin === 'startup' ? '启动超时（窗口内无 Worker 汇报）' : '执行超时'}，已自动重试`, 'warning');
    } catch {
      result.retryExhausted.push(taskId);
      await this.options.notify?.(`任务 ${taskId} 超时且重试预算耗尽（origin=${origin}），需人工介入`, 'critical');
    }
  }

  /** starting 分类：启动窗口内无汇报 → 判 failed 并重试；Worker Agent 仍在执行则宽限（FB-2）；窗口按任务分类覆盖。 */
  private async scanStarting(taskId: string, assignedSessionId: string | null, category: string | null, result: WatchdogScan): Promise<void> {
    const openRun = this.taskManager.runs.byTask(taskId).find((r) => r.ended_at === null);
    if (!openRun) return;
    const startedAt = Date.parse(openRun.started_at);
    if (Number.isNaN(startedAt) || Date.now() - startedAt < this.categoryEffectiveMs(category, 'startingTimeoutMs', this.startingTimeoutMs())) return;
    if (assignedSessionId !== null && this.options.agents !== undefined) {
      const agent = await this.options.agents.getAgent(assignedSessionId).catch(() => undefined);
      if (agent?.status === 'running') {
        // Worker 真实在干活（首报慢于启动窗口——长上下文会话常态）：不判死，
        // 交给 timeout 分类的执行超时窗口（默认 30 分钟）兜底。
        result.startupGrace.push(taskId);
        return;
      }
    }
    if (this.taskManager.markStartupTimeout(taskId)) {
      result.startupExpired.push(taskId);
      await this.failAndRetry(taskId, 'startup', result);
    }
  }

  /** idle/lost 分类：已汇报任务的 Worker 会话活性（需 agents 适配器，缺省跳过）；阈值按任务分类覆盖。 */
  private async scanWorkerLiveness(taskId: string, assignedSessionId: string | null, lastReportAt: string, category: string | null, result: WatchdogScan): Promise<void> {
    if (this.options.agents === undefined || assignedSessionId === null) return;
    const idleStale = this.categoryEffectiveMs(category, 'idleStaleMs', this.idleStaleMs());
    const sinceReport = Date.now() - Date.parse(lastReportAt);
    if (sinceReport < idleStale) {
      this.lostSuspects.delete(taskId);
      return;
    }
    const agent = await this.options.agents.getAgent(assignedSessionId);
    if (agent !== undefined) {
      this.lostSuspects.delete(taskId);
      result.idleSuspects.push(taskId);
      // FB-11 两段式：超龄先催告 Worker 立即补心跳（去抖），同时升级告警 Router（info→warning）
      const nudged = await this.nudgeHeartbeat(taskId, assignedSessionId, idleStale);
      await this.options.notify?.(
        `任务 ${taskId} 的 Worker 会话空闲已超 ${Math.round(idleStale / 60000)} 分钟且无汇报${nudged ? '（已催告心跳）' : '（本轮催告去抖中）'}，请核实进展`,
        'warning',
      );
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

  /** 心跳催告（FB-11）：idleStale 窗口内每任务只催一次；steer 失败不记去抖（下轮重试）。 */
  private async nudgeHeartbeat(taskId: string, assignedSessionId: string, idleStaleMs: number): Promise<boolean> {
    const last = this.nudgedAt.get(taskId);
    if (last !== undefined && Date.now() - last < idleStaleMs) return false;
    try {
      await this.agentController.steerTask(taskId, HEARTBEAT_NUDGE(Math.round(idleStaleMs / 60000)), { role: 'system' });
      this.nudgedAt.set(taskId, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  /** 分类级有效节奏：任务分类命中覆盖表且值为正 → 覆盖值，否则全局值（0.7.2 差异化跟进）。 */
  private categoryEffectiveMs(category: string | null, key: 'startingTimeoutMs' | 'idleStaleMs' | 'heartbeatIntervalMs', globalValue: number): number {
    if (category === null) return globalValue;
    const overrides = readCategoryOverrides(this.options.settings);
    const value = overrides[category]?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : globalValue;
  }

  /** 零 LLM 进度快照（FB-12）：running 任务 × 最近汇报 × 会话 Agent 状态，逐任务落事件流水。 */
  private async recordProgressSnapshots(): Promise<ProgressSnapshot[]> {
    const snapshots: ProgressSnapshot[] = [];
    for (const task of this.taskManager.tasks.list({ status: 'running' })) {
      const report = this.taskManager.reports.latestOf(task.id);
      let agentStatus: ProgressSnapshot['agentStatus'] = 'unknown';
      if (task.assigned_session_id !== null && this.options.agents !== undefined) {
        const agent = await this.options.agents.getAgent(task.assigned_session_id).catch(() => undefined);
        agentStatus = agent === undefined ? 'absent' : agent.status;
      }
      const ageMs = task.last_report_at === null ? null : Date.now() - Date.parse(task.last_report_at);
      const snapshot: ProgressSnapshot = {
        taskId: task.id,
        lastReportAgeSec: ageMs === null ? null : Math.round(ageMs / 1000),
        progress: report?.progress ?? null,
        summary: report?.summary ?? null,
        agentStatus,
      };
      snapshots.push(snapshot);
      this.taskManager.events.ingest({
        eventId: `progress-snapshot:${task.id}:${Date.now()}`,
        source: 'internal',
        type: 'task.progress_snapshot',
        taskId: task.id,
        payloadJson: JSON.stringify(snapshot),
      });
    }
    return snapshots;
  }

  /** 巡检摘要事件（FB-13）：零 LLM 常态巡检的台账——异常分类计数与运行任务数（事件流可查）。 */
  private recordPatrolSummary(result: WatchdogScan, snapshots: ProgressSnapshot[]): void {
    this.taskManager.events.ingest({
      eventId: `patrol-summary:${Date.now()}`,
      source: 'internal',
      type: 'patrol.summary',
      payloadJson: JSON.stringify({
        expired: result.expired.length,
        startupExpired: result.startupExpired.length,
        startupGrace: result.startupGrace.length,
        needHumanEscalated: result.needHumanEscalated.length,
        idleSuspects: result.idleSuspects.length,
        lost: result.lost.length,
        retried: result.retried.length,
        retryExhausted: result.retryExhausted.length,
        runningCount: snapshots.length,
      }),
    });
  }

  /** 进度推送（FB-12）：间隔到点且有运行中任务 → Router/IM 汇总一条；progress_push_interval_ms=0 关闭。 */
  private async pushProgressIfDue(snapshots: ProgressSnapshot[]): Promise<void> {
    const interval = this.progressPushIntervalMs();
    if (interval === 0) return;
    if (Date.now() - this.progressPushedAt < interval) return;
    if (snapshots.length === 0) return;
    this.progressPushedAt = Date.now();
    const lines = snapshots.map((s) => {
      const progress = s.progress === null ? '无汇报' : `${s.progress}%`;
      const age = s.lastReportAgeSec === null ? '从未汇报' : `${Math.max(1, Math.round(s.lastReportAgeSec / 60))} 分钟前`;
      const summary = (s.summary ?? '').slice(0, 60);
      return `- ${s.taskId}（${progress}，${age}，会话${s.agentStatus}${summary !== '' ? `：${summary}` : ''}）`;
    });
    await this.options.notify?.(`运行中任务 ${snapshots.length} 个：\n${lines.join('\n')}`, 'info');
  }
}

/** 单任务的零 LLM 进度快照（FB-12）。 */
export interface ProgressSnapshot {
  taskId: string;
  lastReportAgeSec: number | null;
  progress: number | null;
  summary: string | null;
  agentStatus: 'running' | 'idle' | 'absent' | 'unknown';
}

/** 心跳催告文案（FB-11：要求 Worker 立即补报 running 心跳）。 */
const HEARTBEAT_NUDGE = (staleMinutes: number): string =>
  `【心跳催告】距上次汇报已超过 ${staleMinutes} 分钟——请立即调用 worker_report（status=running，progress/summary 简述当前进展）补报心跳`;

/** 正数覆盖值（非正数/NaN 视为未配置，回退缺省）。 */
function positiveOverride(configured: number | undefined, fallback: number): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : fallback;
}
