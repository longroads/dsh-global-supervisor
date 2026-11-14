/**
 * worker_reports 表 Repository：原始汇报留档（验证通过后入库，状态转换由 TaskManager 决定）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ReportStatus } from '../../protocols/worker-report.js';

function now(): string {
  return new Date().toISOString();
}

/** worker_reports 表行。 */
export interface WorkerReportRow {
  id: number;
  task_id: string;
  session_id: string;
  status: ReportStatus;
  progress: number | null;
  summary: string | null;
  blockers_json: string;
  need_human: number;
  suggested_actions_json: string;
  received_at: string;
  applied: number;
}

export class WorkerReportRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 入档一份原始汇报，返回自增 ID。 */
  record(input: {
    taskId: string;
    sessionId: string;
    status: ReportStatus;
    progress?: number;
    summary?: string;
    blockersJson?: string;
    needHuman?: boolean;
    suggestedActionsJson?: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO worker_reports(task_id, session_id, status, progress, summary, blockers_json, need_human, suggested_actions_json, received_at, applied)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.taskId,
        input.sessionId,
        input.status,
        input.progress ?? null,
        input.summary ?? null,
        input.blockersJson ?? '[]',
        input.needHuman ? 1 : 0,
        input.suggestedActionsJson ?? '[]',
        now(),
      );
    return Number(result.lastInsertRowid);
  }

  /** 标记该汇报已被状态机应用。 */
  markApplied(id: number): void {
    this.db.prepare('UPDATE worker_reports SET applied = 1 WHERE id = ?').run(id);
  }

  byTask(taskId: string): WorkerReportRow[] {
    return this.db
      .prepare('SELECT * FROM worker_reports WHERE task_id = ? ORDER BY id DESC')
      .all(taskId) as unknown as WorkerReportRow[];
  }

  latestOf(taskId: string): WorkerReportRow | undefined {
    return this.db
      .prepare('SELECT * FROM worker_reports WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as WorkerReportRow | undefined;
  }
}
