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
