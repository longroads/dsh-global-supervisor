/**
 * 任务状态机（docs/DEVELOPMENT_PLAN.md §5.2）：
 * 唯一合法转换表 + 断言。TaskManager 是唯一调用方；Worker 只能经 worker_report 间接触发。
 */
import type { TaskStatus } from '../types/index.js';

/**
 * 合法转换表：from → 允许的 to 集合。completed 与 canceled 为终态。
 * queued/failed → 终态（completed/need_human/failed）为"迟到汇报收编"专用路径：
 * watchdog 启动超时误判后，Worker 迟到的终态汇报经 TaskManager 收编直达终态（FB-1）；
 * 仅在任务非 running 时生效——第二次 run 已开始（running）时不开，避免误伤新 run。
 * need_human 开放 running/completed/failed（P1-6 决策闭环）：running = 决策经 steer 注入后
 * Worker 恢复执行的汇报；completed/failed = 等待决策期间任务实际已出终局（收编）。
 * failed → failed 不在此列（自转换非法）：迟到 failed 汇报收编时状态本就一致，
 * TaskManager 仅标记汇报已应用，无需状态写入。
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['queued', 'canceled'],
  queued: ['running', 'completed', 'need_human', 'failed', 'canceled'],
  running: ['completed', 'blocked', 'need_human', 'failed', 'canceled'],
  blocked: ['queued', 'canceled'],
  need_human: ['queued', 'running', 'completed', 'failed', 'canceled'],
  failed: ['queued', 'completed', 'need_human', 'canceled'],
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
