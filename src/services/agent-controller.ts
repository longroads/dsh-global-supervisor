/**
 * AgentController：任务派发编排（方案 §6.2 / D2 链路）。
 * ModelQueue 许可窗口 = markDispatched → worker_report 终态（并发 1 语义落在执行期）；
 * 终态释放经本类包装 applyWorkerReport 实现（工具层唯一入口保证不漏释放）。
 */
import type { DshAgentAdapter } from '../adapters/dsh-agent.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ReleaseHandle } from './model-queue.js';
import { ModelQueue } from './model-queue.js';
import type { ReportOutcome } from './task-manager.js';
import { TaskManager } from './task-manager.js';
import type { WorkerReport } from '../protocols/worker-report.js';

/** 派发结果（机器消费值）。 */
export interface DispatchResult {
  dispatched: boolean;
  reason: 'ok' | 'no-worker-session' | 'busy' | 'task-missing';
  taskId: string;
}

/** 默认执行超时（30 分钟，方案 §5.1 tasks.timeout_at）。 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class AgentController {
  private readonly queue: ModelQueue;
  private readonly permits = new Map<string, ReleaseHandle>();

  constructor(
    private readonly agents: DshAgentAdapter,
    readonly taskManager: TaskManager,
    private readonly db: DatabaseSync,
    maxConcurrency = 1,
  ) {
    this.queue = new ModelQueue(maxConcurrency);
  }

  /**
   * 派发任务：queued → running → followup 指令（含汇报要求）。
   * 并发许可保持到 worker_report 终态。
   */
  async dispatchTask(taskId: string): Promise<DispatchResult> {
    const task = this.taskManager.tasks.byId(taskId);
    if (!task) return { dispatched: false, reason: 'task-missing', taskId };
    const project = this.taskManager.projects.byId(task.project_id);
    const workerSession = project?.worker_session_id;
    if (!workerSession) return { dispatched: false, reason: 'no-worker-session', taskId };
    if (await this.agents.isBusy(workerSession)) {
      return { dispatched: false, reason: 'busy', taskId };
    }
    const permit = await this.queue.submit({ id: taskId, priority: task.priority });
    try {
      this.taskManager.markDispatched(taskId, workerSession, new Date(Date.now() + DEFAULT_TIMEOUT_MS).toISOString());
      await this.agents.dispatch(workerSession, this.buildInstruction(taskId, task.title, task.description));
      this.permits.set(taskId, permit);
      return { dispatched: true, reason: 'ok', taskId };
    } catch (error) {
      permit.release();
      throw error;
    }
  }

  /**
   * 应用 Worker 汇报：TaskManager 状态机 + 终态释放并发许可。
   * worker_report 工具的唯一后端入口。
   */
  applyWorkerReport(report: WorkerReport, callerSessionId: string): ReportOutcome {
    const outcome = this.taskManager.applyWorkerReport(report, callerSessionId);
    if (outcome.accepted && (outcome.reason === 'applied')) {
      const permit = this.permits.get(report.taskId);
      if (permit) {
        permit.release();
        this.permits.delete(report.taskId);
      }
    }
    return outcome;
  }

  /** 运行中纠偏。 */
  async steerTask(taskId: string, text: string): Promise<boolean> {
    const task = this.taskManager.tasks.byId(taskId);
    if (!task?.assigned_session_id) return false;
    await this.agents.steer(task.assigned_session_id, text);
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

  /** 组装任务指令文本（含 worker_report 汇报要求）。 */
  private buildInstruction(taskId: string, title: string, description: string): string {
    return [
      `【任务派发】${taskId}`,
      `标题：${title}`,
      description ? `说明：${description}` : '',
      '',
      '执行要求：完成或状态变化时调用 worker_report 工具汇报（workspace_id/task_id/status/progress/summary），',
      `其中 task_id 必须为 ${taskId}；任务完成时 status=completed。`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
}
