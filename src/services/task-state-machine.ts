/**
 * 任务状态机（docs/DEVELOPMENT_PLAN.md §5.2）：
 * 唯一合法转换表 + 断言。TaskManager 是唯一调用方；Worker 只能经 worker_report 间接触发。
 */
import type { TaskStatus } from '../types/index.js';

/** 合法转换表：from → 允许的 to 集合。completed 与 canceled 为终态。 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['queued', 'canceled'],
  queued: ['running', 'canceled'],
  running: ['completed', 'blocked', 'need_human', 'failed'],
  blocked: ['queued', 'canceled'],
  need_human: ['queued', 'canceled'],
  failed: ['queued', 'canceled'],
  completed: [],
  canceled: [],
};

/** 判断一次转换是否合法。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 非法转换错误（携带 from/to 机器值，供上层稳定判别）。 */
export class InvalidTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`非法任务状态转换：${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** 断言转换合法，非法即抛 InvalidTransitionError。 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** 读取某状态的可转移目标（供 Router 工具展示与测试使用）。 */
export function allowedTargets(from: TaskStatus): readonly TaskStatus[] {
  return ALLOWED_TRANSITIONS[from];
}
