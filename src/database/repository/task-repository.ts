/**
 * tasks 表 Repository：任务记录读写与状态字段落库（状态语义校验在 TaskManager，本层只写）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { TaskRow, TaskStatus } from '../../types/index.js';

function now(): string {
  return new Date().toISOString();
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 生成下一个任务 ID：`task-<yyyymmdd>-<三位序号>`（当日单调递增，单写者安全）。
   * 当日既有最大序号用字典序范围查询（前缀到其下一字符 '.'），避免 LIKE 转义歧义。
   */
  nextTaskId(): string {
    const date = new Date();
    const ymd = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('');
    const prefix = `task-${ymd}-`;
    const upperBound = `task-${ymd}.`;
    const row = this.db
      .prepare('SELECT MAX(CAST(SUBSTR(id, -3) AS INTEGER)) AS seq FROM tasks WHERE id >= ? AND id < ?')
      .get(prefix, upperBound) as { seq: number | null };
    const next = (row.seq ?? 0) + 1;
    return `${prefix}${String(next).padStart(3, '0')}`;
  }

  /** 新建任务（status 固定 pending，时间戳自动盖章）。 */
  create(input: {
    id: string;
    projectId: string;
    title: string;
    description?: string;
    priority?: number;
    parentTaskId?: string;
    maxRetries?: number;
    dueAt?: string;
    scheduleBindingId?: string;
    sourceEventId?: string;
    channelRef?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tasks(id, project_id, parent_task_id, title, description, priority, status, schedule_binding_id, source_event_id, channel_ref, max_retries, due_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.parentTaskId ?? null,
        input.title,
        input.description ?? '',
        input.priority ?? 3,
        input.scheduleBindingId ?? null,
        input.sourceEventId ?? null,
        input.channelRef ?? null,
        input.maxRetries ?? 2,
        input.dueAt ?? null,
        now(),
        now(),
      );
  }

  byId(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  list(filter: { projectId?: string; status?: TaskStatus } = {}): TaskRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId !== undefined) { conditions.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.status !== undefined) { conditions.push('status = ?'); params.push(filter.status); }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(...params) as unknown as TaskRow[];
  }

  /** 更新状态（updated_at 盖章）。转换合法性由 TaskManager 校验。 */
  updateStatus(id: string, status: TaskStatus): boolean {
    const result = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return result.changes > 0;
  }

  /** 派发簿记：执行会话与超时时间。 */
  markDispatched(id: string, assignedSessionId: string, timeoutAt: string | null): boolean {
    const result = this.db
      .prepare('UPDATE tasks SET assigned_session_id = ?, timeout_at = ?, updated_at = ? WHERE id = ?')
      .run(assignedSessionId, timeoutAt, now(), id);
    return result.changes > 0;
  }

  /** 最近一次 Worker 汇报时间（看门狗依据）。 */
  touchReport(id: string): void {
    this.db.prepare('UPDATE tasks SET last_report_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
  }

  /** 重试计数递增。 */
  incrementRetry(id: string): void {
    this.db.prepare('UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?').run(now(), id);
  }

  /** 写任务级模型偏好（null 清除）。 */
  setModelPref(id: string, modelPrefJson: string | null): boolean {
    const result = this.db.prepare('UPDATE tasks SET model_pref_json = ?, updated_at = ? WHERE id = ?').run(modelPrefJson, now(), id);
    return result.changes > 0;
  }

  /** 依赖登记（自引用在 D CHECK 层拒绝；环路检测在 TaskManager）。 */
  addDependency(taskId: string, dependsOnTaskId: string): void {
    this.db
      .prepare('INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES(?, ?)')
      .run(taskId, dependsOnTaskId);
  }

  /** 某任务依赖的前置任务 ID 集合。 */
  dependenciesOf(taskId: string): string[] {
    const rows = this.db
      .prepare('SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ?')
      .all(taskId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
