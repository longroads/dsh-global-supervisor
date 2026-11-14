/**
 * task_runs 表 Repository：每次执行尝试一条记录，重试不覆盖历史。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RunOutcome, TaskRunRow } from '../../types/index.js';

function now(): string {
  return new Date().toISOString();
}

export class TaskRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 开始一次执行尝试（started_at 盖章），返回自增 ID。 */
  start(input: { taskId: string; sessionId: string; attemptNo: number }): number {
    const result = this.db
      .prepare('INSERT INTO task_runs(task_id, session_id, attempt_no, started_at) VALUES(?, ?, ?, ?)')
      .run(input.taskId, input.sessionId, input.attemptNo, now());
    return Number(result.lastInsertRowid);
  }

  /** 结束一次尝试并写入终局。 */
  finish(id: number, outcome: RunOutcome, detail: { resultSummary?: string; errorMessage?: string; usageJson?: string } = {}): boolean {
    const result = this.db
      .prepare('UPDATE task_runs SET ended_at = ?, outcome = ?, result_summary = ?, error_message = ?, usage_json = ? WHERE id = ?')
      .run(now(), outcome, detail.resultSummary ?? null, detail.errorMessage ?? null, detail.usageJson ?? null, id);
    return result.changes > 0;
  }

  byTask(taskId: string): TaskRunRow[] {
    return this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_no').all(taskId) as unknown as TaskRunRow[];
  }

  byId(id: number): TaskRunRow | undefined {
    return this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as TaskRunRow | undefined;
  }
}
