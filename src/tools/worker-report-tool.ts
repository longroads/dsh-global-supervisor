/**
 * Worker 侧工具（worker_report）：结构化汇报的唯一入口。
 * 权限：执行期校验调用者是某受管项目的 Worker 会话（projects.worker_session_id）；
 * 任务归属（assigned_session）由 TaskManager 第三防线校验。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SupervisorStack } from '../runtime.js';
import { parseWorkerReport, ReportValidationError } from '../protocols/worker-report.js';
import { makeTool } from './toolkit.js';

/** 构建 worker_report 工具。 */
export function buildWorkerReportTool(stack: SupervisorStack): ToolDefinition {
  return makeTool({
    name: 'worker_report',
    description: 'Worker 汇报任务进展（workspace_id/task_id/status 必填；status ∈ running/completed/blocked/need_human/failed；仅可汇报派发给本会话的任务）',
    parameters: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: '所属 DSH workspace ID' },
        task_id: { type: 'string', description: '任务 ID（派发指令中的 task-xxx）' },
        status: { type: 'string', description: 'running/completed/blocked/need_human/failed' },
        progress: { type: 'integer', description: '0-100' },
        summary: { type: 'string', description: '当前进展摘要' },
        blockers: { type: 'array', items: { type: 'string' }, description: '阻碍清单' },
        need_human: { type: 'boolean', description: '是否需要人工决策' },
        suggested_actions: { type: 'array', items: { type: 'string' }, description: '建议后续动作' },
        evidence: { type: 'string', description: '完成证据：结果文件绝对路径或关键输出摘要（任务带验收条件时用于系统核验）' },
      },
      required: ['workspace_id', 'task_id', 'status'],
    },
    resultSchema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean' },
        reason: { type: 'string' },
      },
      additionalProperties: true,
    },
    guard: (caller) => stack.taskManager.projects.list(true).some((project) => project.worker_session_id === caller),
    guardDeniedMessage: '仅受管项目的 Worker 会话可调用 worker_report',
    handler: (args, ctx) => {
      let report;
      try {
        report = parseWorkerReport(args);
      } catch (error) {
        if (error instanceof ReportValidationError) {
          return { accepted: false, reason: 'invalid-payload', issues: error.issues };
        }
        throw error;
      }
      const outcome = stack.agentController.applyWorkerReport(report, ctx.callerSessionId);
      // 闭环通知硬接线（FB-4）：拒收/终态必达 Router，独立于事件路由 observe/auto 开关
      if (!outcome.accepted) {
        void stack.notifier.notify(
          `Worker 汇报被拒（reason=${outcome.reason}）：任务 ${report.taskId} 当前状态 ${outcome.taskStatus ?? 'unknown'}，请人工核查`,
          'critical',
        );
        void stack.eventManager.ingest({
          eventId: `worker-report-rejected:${report.taskId}:${Date.now()}`,
          source: 'internal',
          type: 'worker_report.rejected',
          taskId: report.taskId,
          payloadJson: JSON.stringify({ reason: outcome.reason, taskStatus: outcome.taskStatus, workerSession: ctx.callerSessionId }),
        });
      }
      // 需人介入时唤醒 Router 会话转述（通知尽力而为，不阻断汇报结果）
      if (outcome.accepted && report.needHuman) {
        void stack.notifier.notify(
          `任务 ${report.taskId} 需要人工决策：${report.summary ?? ''}${report.blockers.length > 0 ? `（阻碍：${report.blockers.join('；')}）` : ''}`,
          'warning',
        );
      }
      // 终态送达 Router（completed=info / failed=warning；adopted 收编同样通知）
      if (outcome.accepted && (outcome.reason === 'applied' || outcome.reason === 'adopted')) {
        const terminal = outcome.taskStatus === 'completed' ? 'completed' : outcome.taskStatus === 'failed' ? 'failed' : '';
        if (terminal !== '') {
          void stack.notifier.notify(
            `任务 ${report.taskId} ${terminal === 'completed' ? '已完成' : '失败'}（${outcome.reason}）：${report.summary ?? ''}`,
            terminal === 'completed' ? 'info' : 'warning',
          );
        }
        // 0.7.2 派发契约轻验证：有验收条件的 completed 汇报核验 evidence（文件存在 + mtime 晚于本次 run 开始）
        if (terminal === 'completed') {
          void verifyCompletionEvidence(stack, report.taskId, report.evidence);
        }
        void stack.eventManager.ingest({
          eventId: `task-terminal:${report.taskId}:${outcome.taskStatus}:${Date.now()}`,
          source: 'internal',
          type: 'task.terminal',
          taskId: report.taskId,
          payloadJson: JSON.stringify({ status: outcome.taskStatus, via: outcome.reason, workerSession: ctx.callerSessionId }),
        });
      }
      // 来源事件带信道（channel_ref）的任务，完成时经该信道回复摘要（Phase 4 4-C）
      if (outcome.accepted && outcome.taskStatus === 'completed') {
        const task = stack.taskManager.tasks.byId(report.taskId);
        if (task?.channel_ref) {
          void stack.notifier.notify(`任务 ${task.id} 已完成：${report.summary ?? ''}`, 'info');
        }
      }
      return outcome;
    },
  });
}

/** 证据是否为文件绝对路径形态（Unix / 开头或 Windows 盘符开头）。 */
function looksLikeAbsolutePath(text: string): boolean {
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text);
}

/**
 * 0.7.2 完成轻验证（零 LLM）：任务带验收条件时核验 evidence——
 * - evidence 为绝对路径 → 检查文件存在且 mtime 晚于本次 run 开始（产出确为本次执行产物）；
 * - evidence 缺失或非路径 → 标记未验证（verified=0），提醒补证；
 * - 任务无验收条件 → 不验证（verified 保持 NULL）。
 * 验证结果写任务行与审计；不改变 completed 状态（轻验证不拦截，只标注可信度）。
 */
async function verifyCompletionEvidence(stack: SupervisorStack, taskId: string, evidence: string | undefined): Promise<void> {
  try {
    const task = stack.taskManager.tasks.byId(taskId);
    if (!task || task.acceptance === null) return;
    let verified: 0 | 1 = 0;
    let detail = 'evidence 缺失或非文件路径，未验证';
    if (evidence !== undefined && looksLikeAbsolutePath(evidence)) {
      const { stat } = await import('node:fs/promises');
      const stats = await stat(evidence).catch(() => undefined);
      if (stats === undefined) {
        detail = `证据文件不存在：${evidence}`;
      } else {
        const run = stack.taskManager.runs.byTask(taskId).find((r) => r.ended_at !== null);
        const runStartedMs = run !== undefined ? Date.parse(run.started_at) : 0;
        verified = stats.mtimeMs >= runStartedMs ? 1 : 0;
        detail = verified === 1 ? `证据文件核验通过（mtime 晚于派发）：${evidence}` : `证据文件早于派发时间（疑似旧产物）：${evidence}`;
      }
    }
    stack.taskManager.tasks.setVerified(taskId, verified);
    stack.taskManager.audit.log({
      actorRole: 'system',
      action: 'task.verification',
      targetType: 'task',
      targetId: taskId,
      detailJson: JSON.stringify({ verified, evidence: evidence ?? null, acceptance: task.acceptance }),
    });
    if (verified === 0) {
      await stack.notifier.notify(`任务 ${taskId} 完成但证据未通过核验（${detail}）——验收条件：${task.acceptance}`, 'warning').catch(() => false);
    }
  } catch {
    // 验证是旁路增强：内部故障只降级为本次未验证，不影响已 accepted 的汇报
  }
}
