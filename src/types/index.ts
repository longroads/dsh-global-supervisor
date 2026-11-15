/**
 * 插件公共类型定义。
 * @module dsh-global-supervisor
 */

/** 单项 API 兼容性检查的结果状态（与 docs/API_COMPATIBILITY.md 对齐）。 */
export type ProbeStatus = 'VERIFIED' | 'UNAVAILABLE' | 'UNSTABLE' | 'SKIPPED';

/** 一项检查的完整记录。 */
export interface ProbeCheck {
  /** 检查项 ID（稳定标识，写入兼容性报告） */
  id: string;
  /** 检查内容的人类可读描述 */
  name: string;
  /** 结果状态 */
  status: ProbeStatus;
  /** 证据：签名、返回值摘要或失败原因 */
  detail: string;
  /** 耗时（毫秒） */
  durationMs: number;
}

/** 一次探针运行的完整报告。 */
export interface ProbeReport {
  /** 运行时间（RFC3339） */
  ranAt: string;
  /** 宿主 Node 版本 */
  nodeVersion: string;
  /** 插件版本 */
  pluginVersion: string;
  /** 数据目录（报告与数据库的落盘位置） */
  dataDir: string;
  /** 全部检查项 */
  checks: ProbeCheck[];
}

/** 角色配置：Router 会话的识别依据（权限三道防线的第一道）。 */
export interface RoleConfig {
  /** Router 所属的 DSH Workspace ID */
  routerWorkspaceId: string;
  /** Router 的固定会话 ID（supervisor_* 工具唯一挂载点） */
  routerSessionId: string;
}

/** 任务状态（严格状态机，见 src/services/task-state-machine.ts）。 */
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'need_human'
  | 'failed'
  | 'canceled';

/** 项目状态（业务层；归档≠删除 DSH workspace 注册）。 */
export type ProjectStatus = 'active' | 'paused' | 'archived';

/** 项目健康度（由最近 Worker 汇报推导）。 */
export type ProjectHealth = 'ok' | 'warning' | 'blocked' | 'unknown';

/** 单次任务执行的终局。 */
export type RunOutcome = 'completed' | 'failed' | 'timeout' | 'canceled';

/** 事件来源。 */
export type EventSource = 'schedule' | 'im' | 'agent' | 'system' | 'internal' | 'webhook';

/** projects 表行。 */
export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  priority: number;
  status: ProjectStatus;
  worker_session_id: string | null;
  goals_json: string;
  health: ProjectHealth;
  last_review_at: string | null;
  next_review_at: string | null;
  created_at: string;
  updated_at: string;
}

/** tasks 表行。 */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  priority: number;
  status: TaskStatus;
  assigned_session_id: string | null;
  schedule_binding_id: string | null;
  retry_count: number;
  max_retries: number;
  timeout_at: string | null;
  due_at: string | null;
  last_report_at: string | null;
  created_at: string;
  updated_at: string;
}

/** task_runs 表行。 */
export interface TaskRunRow {
  id: number;
  task_id: string;
  session_id: string;
  attempt_no: number;
  started_at: string;
  ended_at: string | null;
  outcome: RunOutcome | null;
  result_summary: string | null;
  error_message: string | null;
  usage_json: string | null;
}

/** events 表行。 */
export interface EventRow {
  id: number;
  event_id: string;
  source: EventSource;
  type: string;
  workspace_id: string | null;
  task_id: string | null;
  payload_json: string;
  dedup_hash: string | null;
  thread_id: string | null;
  channel_ref: string | null;
  actor_json: string | null;
  human: number;
  created_at: string;
}

/** routing_rules 表行。 */
export interface RoutingRuleRow {
  id: string;
  keyword: string;
  workspace_id: string;
  created_by: string;
  note: string;
  hit_count: number;
  enabled: number;
  created_at: string;
}
