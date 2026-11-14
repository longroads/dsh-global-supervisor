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
      // 需人介入时唤醒 Router 会话转述（通知尽力而为，不阻断汇报结果）
      if (outcome.accepted && report.needHuman) {
        void stack.notifier.notify(
          `任务 ${report.taskId} 需要人工决策：${report.summary ?? ''}${report.blockers.length > 0 ? `（阻碍：${report.blockers.join('；')}）` : ''}`,
        );
      }
      return outcome;
    },
  });
}
