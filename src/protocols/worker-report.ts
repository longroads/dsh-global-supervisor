/**
 * Worker 汇报协议 v1 的严格校验（DEVELOPMENT_PLAN §5.3）。
 * 未知字段一律拒绝；类型与范围逐项检查。只依赖协议本身，无 DSH 依赖。
 */
import type { TaskStatus } from '../types/index.js';

/** 汇报中允许出现的任务状态（协议枚举，非完整任务状态机）。 */
export const REPORT_STATUSES = ['running', 'completed', 'blocked', 'need_human', 'failed'] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** 一份合法的 Worker 汇报（校验通过后的规范形态）。 */
export interface WorkerReport {
  workspaceId: string;
  taskId: string;
  status: ReportStatus;
  progress?: number;
  summary?: string;
  blockers: string[];
  needHuman: boolean;
  suggestedActions: string[];
  /** 完成证据（0.7.2 派发契约）：文件绝对路径或输出摘要，completed 汇报时用于轻验证。 */
  evidence?: string;
}

/** 校验失败（机器可消费的稳定错误）。 */
export class ReportValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Worker 汇报校验失败：${issues.join('；')}`);
    this.name = 'ReportValidationError';
    this.issues = issues;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 校验并归一化原始载荷（通常是工具参数反序列化结果）。 */
export function parseWorkerReport(input: unknown): WorkerReport {
  const issues: string[] = [];
  if (!isObject(input)) {
    throw new ReportValidationError(['载荷必须是对象']);
  }
  const allowed = new Set(['workspace_id', 'task_id', 'status', 'progress', 'summary', 'blockers', 'need_human', 'suggested_actions', 'evidence']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push(`未知字段：${key}`);
    }
  }
  const workspaceId = input['workspace_id'];
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    issues.push('workspace_id 必须是非空字符串');
  }
  const taskId = input['task_id'];
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    issues.push('task_id 必须是非空字符串');
  }
  const status = input['status'];
  if (typeof status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(status)) {
    issues.push(`status 必须是 ${REPORT_STATUSES.join('/')} 之一`);
  }
  const progress = input['progress'];
  if (progress !== undefined && (typeof progress !== 'number' || !Number.isInteger(progress) || progress < 0 || progress > 100)) {
    issues.push('progress 必须是 0-100 的整数');
  }
  const summary = input['summary'];
  if (summary !== undefined && typeof summary !== 'string') {
    issues.push('summary 必须是字符串');
  }
  const blockers = input['blockers'] ?? [];
  if (!isStringArray(blockers)) {
    issues.push('blockers 必须是字符串数组');
  }
  const needHuman = input['need_human'] ?? false;
  if (typeof needHuman !== 'boolean') {
    issues.push('need_human 必须是布尔值');
  }
  const suggested = input['suggested_actions'] ?? [];
  if (!isStringArray(suggested)) {
    issues.push('suggested_actions 必须是字符串数组');
  }
  const evidence = input['evidence'];
  if (evidence !== undefined && typeof evidence !== 'string') {
    issues.push('evidence 必须是字符串');
  }
  if (issues.length > 0) {
    throw new ReportValidationError(issues);
  }
  // 到达此处时 issues 为空，即全部字段已通过运行时校验，断言是收窄而非放宽。
  return {
    workspaceId: workspaceId as string,
    taskId: taskId as string,
    status: status as ReportStatus,
    progress: progress as number | undefined,
    summary: summary as string | undefined,
    blockers: blockers as string[],
    needHuman: needHuman as boolean,
    suggestedActions: suggested as string[],
    evidence: evidence as string | undefined,
  };
}

/** 汇报状态到目标任务状态的映射（running 仅刷新心跳，不转移）。 */
export function targetStatusOf(reportStatus: ReportStatus): TaskStatus | null {
  switch (reportStatus) {
    case 'running': return null;
    case 'completed': return 'completed';
    case 'blocked': return 'blocked';
    case 'need_human': return 'need_human';
    case 'failed': return 'failed';
  }
}
