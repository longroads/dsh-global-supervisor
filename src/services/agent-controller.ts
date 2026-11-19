/**
 * AgentController：任务派发编排（方案 §6.2 / D2 链路）。
 * ModelQueue 许可窗口 = markDispatched → worker_report 终态（并发 1 语义落在执行期）；
 * 终态释放经本类包装 applyWorkerReport 实现（工具层唯一入口保证不漏释放）。
 */
import type { DshAgentAdapter } from '../adapters/dsh-agent.js';
import type { ModelPrefInput } from '../adapters/dsh-agent.js';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryRepository } from '../database/repository/memory-repository.js';
import { PluginSettingRepository } from '../database/repository/plugin-setting-repository.js';
import type { ReleaseHandle } from './model-queue.js';
import { ModelQueue } from './model-queue.js';
import { readCategoryOverrides, WATCHDOG_SETTING_KEYS } from './project-monitor.js';
import type { ReportOutcome } from './task-manager.js';
import { TaskManager } from './task-manager.js';
import type { WorkerReport } from '../protocols/worker-report.js';

/** 派发结果（机器消费值）。 */
export interface DispatchResult {
  dispatched: boolean;
  reason: 'ok' | 'no-worker-session' | 'busy' | 'task-missing' | 'adopted' | 'session-degenerated' | 'queue-timeout';
  taskId: string;
}

/** 默认执行超时（30 分钟，方案 §5.1 tasks.timeout_at）。 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** 队列等待上限（FB-18 许可黑洞）：并发许可被前序空转任务占死时，排队等待超过此值即放弃， */
const DEFAULT_QUEUE_WAIT_MS = 90 * 1000;

/** 派发后活性校验延迟（FB-18/20）：followup 后此时刻会话仍未注册 → 快速失败（而非等启动窗口 10 分钟）。 */
const DEFAULT_LIVENESS_CHECK_MS = 30 * 1000;

/** 解析 model_pref_json（畸形返回 undefined——偏好坏行不阻断派发）。 */
function parseModelPref(json: string | null | undefined): ModelPrefInput | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
    if (typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
      return {
        provider: parsed.provider,
        model: parsed.model,
        ...(typeof parsed.reasoningEffort === 'string' ? { reasoningEffort: parsed.reasoningEffort } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class AgentController {
  private readonly queue: ModelQueue;
  private readonly permits = new Map<string, ReleaseHandle>();
  /** 心跳契约 KV 源（与 ProjectMonitor 共用 watchdog.heartbeatIntervalMs 键）。 */
  private readonly pluginSettings: PluginSettingRepository;
  /** 记忆仓库（0.7.2：派发指令注入相关偏好/事实）。 */
  readonly memories: MemoryRepository;
  /** 派发节奏参数（测试可注入小值加速）。 */
  private readonly timing: { queueWaitMs: number; livenessCheckMs: number };

  constructor(
    private readonly agents: DshAgentAdapter,
    readonly taskManager: TaskManager,
    private readonly db: DatabaseSync,
    maxConcurrency = 1,
    timing?: { queueWaitMs?: number; livenessCheckMs?: number },
  ) {
    this.queue = new ModelQueue(maxConcurrency);
    this.pluginSettings = new PluginSettingRepository(db);
    this.memories = new MemoryRepository(db);
    this.timing = {
      queueWaitMs: timing?.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS,
      livenessCheckMs: timing?.livenessCheckMs ?? DEFAULT_LIVENESS_CHECK_MS,
    };
  }

  /** 心跳契约间隔（缺省 5 分钟；任务分类命中覆盖表时用分类值；须小于 idleStaleMs 否则契约必然违约）。 */
  private heartbeatIntervalMs(category?: string | null): number {
    const overridden = category != null ? readCategoryOverrides(this.pluginSettings)[category]?.heartbeatIntervalMs : undefined;
    if (typeof overridden === 'number' && Number.isFinite(overridden) && overridden > 0) return overridden;
    const configured = this.pluginSettings.getJson<number>(WATCHDOG_SETTING_KEYS.heartbeatIntervalMs);
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : 5 * 60 * 1000;
  }

  /**
   * 按需创建 Worker 会话（FB-10①）：生成 session-<uuid> 身份并落在指定 workspace 目录。
   * 用于长寿命会话行为退化后的会话轮换、或一任务一专用执行体（零上下文污染）。
   */
  async createWorkerSession(
    cwd: string,
    actor: { sessionId?: string; role: 'router' | 'system' },
    opts?: { agentPreset?: string; provider?: string; model?: string; sandboxMode?: 'danger-full-access' | 'workspace-write' | 'read-only' },
  ): Promise<string> {
    const { randomUUID } = await import('../utils/id.js');
    const sessionId = `session-${(await randomUUID())}`;
    const liveReady = await this.agents.createSession(sessionId, cwd, opts);
    this.taskManager.audit.log({
      actorSessionId: actor.sessionId,
      actorRole: actor.role,
      action: 'session.create',
      targetType: 'session',
      targetId: sessionId,
      detailJson: JSON.stringify({ cwd, liveReady: liveReady ? 1 : 0, sandboxMode: opts?.sandboxMode ?? 'danger-full-access', ...(opts ?? {}) }),
    });
    return sessionId;
  }

  /**
   * 派发任务：queued → running → followup 指令（含汇报要求）。
   * 并发许可保持到 worker_report 终态。
   * sessionOverride（FB-10②）：任务级执行体——指定会话执行本任务（一任务一专用会话，
   * 不写回项目 worker_session_id，跑完即弃，零上下文污染）。
   */
  async dispatchTask(taskId: string, sessionOverride?: { sessionId: string }): Promise<DispatchResult> {
    const task = this.taskManager.tasks.byId(taskId);
    if (!task) return { dispatched: false, reason: 'task-missing', taskId };
    // 重派前收编（FB-3）：存在未应用的迟到终态汇报时先应用终态，不再重跑整个任务
    if (this.taskManager.adoptLateReport(taskId, { role: 'system' })) {
      return { dispatched: false, reason: 'adopted', taskId };
    }
    const project = this.taskManager.projects.byId(task.project_id);
    const workerSession = sessionOverride?.sessionId ?? project?.worker_session_id ?? undefined;
    if (!workerSession) return { dispatched: false, reason: 'no-worker-session', taskId };
    // 0.7.2 会话退化断路器：项目默认会话对该任务连续 2 次失败 → 拒派建议换会话
    // （用户显式指定 session_id 的派发是明确决策，不做拦截）
    if (sessionOverride === undefined) {
      const history = this.taskManager.runs.byTask(taskId).filter((r) => r.session_id === workerSession);
      const lastTwo = history.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every((r) => r.outcome === 'timeout' || r.outcome === 'failed')) {
        return { dispatched: false, reason: 'session-degenerated', taskId };
      }
    }
    if (await this.agents.isBusy(workerSession)) {
      return { dispatched: false, reason: 'busy', taskId };
    }
    // FB-18 许可黑洞：空转会话永不发终态汇报，并发 1 的许可只能等 watchdog 判死释放——
    // 后续任务在队列里空等 10-30 分钟（实测 20/31 分钟与判死窗口吻合）。
    // 等待超过上限即放弃排队（任务保持 queued，可再次派发）；race 竞态下迟到的许可立即归还。
    const waitLimit = this.timing.queueWaitMs;
    let timedOut = false;
    const permit = await Promise.race([
      this.queue.submit({ id: taskId, priority: task.priority }).then((handle) => {
        if (timedOut) {
          handle.release();
          return undefined as unknown as ReleaseHandle;
        }
        return handle;
      }),
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          this.queue.cancel(taskId);
          resolve(undefined);
        }, waitLimit);
      }),
    ]);
    if (permit === undefined) return { dispatched: false, reason: 'queue-timeout', taskId };
    try {
      this.taskManager.markDispatched(taskId, workerSession, new Date(Date.now() + DEFAULT_TIMEOUT_MS).toISOString());
      const modelPref = parseModelPref(task.model_pref_json) ?? parseModelPref(project?.model_pref_json);
      await this.agents.dispatch(workerSession, this.buildInstruction(task, project?.workspace_id), modelPref);
      this.permits.set(taskId, permit);
      this.scheduleLivenessCheck(taskId, workerSession);
      return { dispatched: true, reason: 'ok', taskId };
    } catch (error) {
      permit.release();
      throw error;
    }
  }

  /**
   * 派发后活性校验（FB-18/20 快速失败）：followup 后延迟检查会话是否出现在 registry——
   * 编程创建缺装配（无预设/无模型路由）的会话往往从未激活，与其等启动窗口 10 分钟判死，
   * 不如尽早释放许可并重排，让队列黑洞窗口从分钟级压到秒级。检查失败不阻塞主流程。
   */
  private scheduleLivenessCheck(taskId: string, sessionId: string): void {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const live = await this.agents.getAgent(sessionId).catch(() => undefined);
          if (live !== undefined) return;
          const task = this.taskManager.tasks.byId(taskId);
          if (task?.status !== 'running' || task.assigned_session_id !== sessionId) return;
          if (this.taskManager.markStartupTimeout(taskId)) {
            this.taskManager.retry(taskId, { role: 'system' });
            this.releasePermit(taskId);
            this.taskManager.audit.log({
              actorRole: 'system',
              action: 'task.dispatch_abort',
              targetType: 'task',
              targetId: taskId,
              detailJson: JSON.stringify({ sessionId, cause: 'session-not-live' }),
            });
          }
        } catch {
          // 校验链路自身异常不升级——watchdog 启动窗口仍是兜底
        }
      })();
    }, this.timing.livenessCheckMs);
    timer.unref?.();
  }

  /**
   * 应用 Worker 汇报：TaskManager 状态机 + 终态释放并发许可。
   * worker_report 工具的唯一后端入口。
   */
  applyWorkerReport(report: WorkerReport, callerSessionId: string): ReportOutcome {
    const outcome = this.taskManager.applyWorkerReport(report, callerSessionId);
    if (outcome.accepted && (outcome.reason === 'applied' || outcome.reason === 'adopted')) {
      const permit = this.permits.get(report.taskId);
      if (permit) {
        permit.release();
        this.permits.delete(report.taskId);
      }
    }
    return outcome;
  }

  /** 对 live 会话立即应用模型选择（工具层入口；冷会话返回 false）。 */
  async applySessionModel(sessionId: string, pref: ModelPrefInput): Promise<boolean> {
    return this.agents.selectModelNow(sessionId, pref);
  }

  /** 运行中纠偏（不排队新轮次；下一模型步生效），留审计。 */
  async steerTask(taskId: string, text: string, actor: { sessionId?: string; role: 'router' | 'worker' | 'system' } = { role: 'system' }): Promise<boolean> {
    const task = this.taskManager.tasks.byId(taskId);
    if (!task?.assigned_session_id) return false;
    await this.agents.steer(task.assigned_session_id, text);
    this.taskManager.audit.log({
      actorSessionId: actor.sessionId,
      actorRole: actor.role,
      action: 'task.steer',
      targetType: 'task',
      targetId: taskId,
      detailJson: JSON.stringify({ text: text.slice(0, 200) }),
    });
    return true;
  }

  /** 取消：Agent 侧停止执行 + TaskManager 终态 + 许可释放。 */
  async cancelTask(taskId: string, actor: { sessionId?: string; role: 'router' | 'worker' | 'system' }): Promise<void> {
    const task = this.taskManager.tasks.byId(taskId);
    if (task?.assigned_session_id) {
      await this.agents.cancelAgent(task.assigned_session_id, 'supervisor 取消任务', true);
    }
    this.taskManager.cancel(taskId, actor);
    const permit = this.permits.get(taskId);
    if (permit) {
      permit.release();
      this.permits.delete(taskId);
    }
  }

  /** 队列状态（诊断）。 */
  stats(): { running: number; waiting: number } {
    return this.queue.stats();
  }

  /**
   * 释放某任务的并发许可（看门狗判超时/重试路径调用）。
   * 许可若不释放，Worker 沉默一次即令后续派发永久挂起——这是队列死锁的唯一来源。
   */
  releasePermit(taskId: string): boolean {
    const permit = this.permits.get(taskId);
    if (!permit) return false;
    permit.release();
    this.permits.delete(taskId);
    return true;
  }

  /** 当前持有的许可数（诊断/测试）。 */
  permitsCount(): number {
    return this.permits.size;
  }

  /** 组装任务指令文本（分类标注 + 验收契约 + 心跳契约 + 相关记忆注入，0.7.2；workspace_id 注入 0.7.5/FB-21③）。 */
  private buildInstruction(task: { id: string; title: string; description: string; category: string | null; acceptance: string | null }, workspaceId?: string, cwd?: string): string {
    const heartbeatMinutes = Math.max(1, Math.round(this.heartbeatIntervalMs(task.category) / 60000));
    const memories = this.relevantMemories(task.title, task.description);
    return [
      `【任务派发】${task.id}${task.category !== null ? `（分类：${task.category}）` : ''}`,
      `标题：${task.title}`,
      task.description !== '' ? `说明：${task.description}` : '',
      ...(task.acceptance !== null
        ? [`验收条件：${task.acceptance}——完成时须在 worker_report 的 evidence 字段附佐证（结果文件绝对路径或关键输出摘要），系统将据此核验`]
        : []),
      ...(workspaceId !== undefined
        ? [`工作区：workspace_id=${workspaceId}${cwd !== undefined ? `（本地路径 ${cwd}，产出文件写入该目录树）` : ''}——worker_report 的 workspace_id 字段使用此值`]
        : []),
      '',
      '执行要求：完成或状态变化时调用 worker_report 工具汇报（workspace_id/task_id/status/progress/summary），',
      `其中 task_id 必须为 ${task.id}；任务完成时 status=completed。`,
      `心跳契约：执行预计超过 ${heartbeatMinutes} 分钟时，必须每 ${heartbeatMinutes} 分钟调用一次 worker_report（status=running，progress/summary 简述当前进展）；`,
      '超时未收到心跳将触发系统催告并升级通知管理端。',
      '防空转要求（FB-15）：接令后第一步必须立即执行产生宿主机可见副作用的动作（如创建本任务工作目录或产出首份文件），完成后才可发送"已开始"类汇报；',
      '只汇报不行动、或汇报后长时间无宿主机痕迹，将被判定空转并触发系统干预（催告/换会话重派）。',
      ...(memories.length > 0 ? ['', '相关记忆（用户偏好与既定事实，执行时遵守）：', ...memories.map((m) => `- ${m}`)] : []),
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * 相关记忆筛选（0.7.2 轻量版）：取 preference/fact 类中与标题/描述共享任意 2-gram 的前 3 条。
   * 不做向量检索——个人规模记忆量下关键词交集足够，避免引入嵌入依赖。
   */
  private relevantMemories(title: string, description: string): string[] {
    const text = `${title} ${description}`;
    const grams: string[] = [];
    for (let i = 0; i + 2 <= text.length; i += 1) grams.push(text.slice(i, i + 2));
    if (grams.length === 0) return [];
    return this.memories
      .list()
      .filter((m) => m.category === 'preference' || m.category === 'fact')
      .filter((m) => grams.some((g) => m.content.includes(g)))
      .slice(0, 3)
      .map((m) => `(${m.category}) ${m.content}`);
  }
}
