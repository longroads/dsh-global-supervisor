/**
 * audit_logs 表 Repository：关键操作审计（谁、何时、动了什么、结果）。
 */
import type { DatabaseSync } from 'node:sqlite';

function now(): string {
  return new Date().toISOString();
}

/** audit_logs 表行。 */
export interface AuditRow {
  id: number;
  actor_session_id: string | null;
  actor_role: 'router' | 'worker' | 'system';
  action: string;
  target_type: string;
  target_id: string;
  detail_json: string;
  created_at: string;
}

export class AuditRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 记录一条审计。 */
  log(input: {
    actorSessionId?: string;
    actorRole: 'router' | 'worker' | 'system';
    action: string;
    targetType: string;
    targetId: string;
    detailJson?: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO audit_logs(actor_session_id, actor_role, action, target_type, target_id, detail_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.actorSessionId ?? null,
        input.actorRole,
        input.action,
        input.targetType,
        input.targetId,
        input.detailJson ?? '{}',
        now(),
      );
  }

  byTarget(targetType: string, targetId: string): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY id')
      .all(targetType, targetId) as unknown as AuditRow[];
  }

  /** 按 action 查询（升序；用于"是否发生过某类操作"的存在性判定）。 */
  byAction(action: string): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY id')
      .all(action) as unknown as AuditRow[];
  }
}
