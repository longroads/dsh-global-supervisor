/**
 * schedule_bindings 表 Repository：业务巡检与 DSH Host Schedule 的关联簿记。
 * 对账语义（与 ctx.schedule.catalog 双向核对）在 Scheduler 服务层。
 */
import type { DatabaseSync } from 'node:sqlite';

function now(): string {
  return new Date().toISOString();
}

/** schedule_bindings 表行。 */
export interface ScheduleBindingRow {
  id: string;
  kind: 'router-review' | 'project-check' | 'custom';
  dsh_schedule_id: string;
  scope_json: string;
  event_id_template: string;
  active: number;
  last_reconciled_at: string | null;
}

export class ScheduleBindingRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 登记绑定（同一 DSH 任务只允许一条绑定）。 */
  upsert(input: { id: string; kind: ScheduleBindingRow['kind']; dshScheduleId: string; scopeJson?: string; eventIdTemplate?: string }): void {
    this.db
      .prepare(
        `INSERT INTO schedule_bindings(id, kind, dsh_schedule_id, scope_json, event_id_template, active, last_reconciled_at)
         VALUES(?, ?, ?, ?, ?, 1, NULL)
         ON CONFLICT(dsh_schedule_id) DO UPDATE SET kind = excluded.kind, scope_json = excluded.scope_json, event_id_template = excluded.event_id_template, active = 1`,
      )
      .run(input.id, input.kind, input.dshScheduleId, input.scopeJson ?? '{}', input.eventIdTemplate ?? '');
  }

  byDshScheduleId(dshScheduleId: string): ScheduleBindingRow | undefined {
    return this.db
      .prepare('SELECT * FROM schedule_bindings WHERE dsh_schedule_id = ?')
      .get(dshScheduleId) as ScheduleBindingRow | undefined;
  }

  list(activeOnly = true): ScheduleBindingRow[] {
    const sql = activeOnly ? 'SELECT * FROM schedule_bindings WHERE active = 1' : 'SELECT * FROM schedule_bindings';
    return this.db.prepare(sql).all() as unknown as ScheduleBindingRow[];
  }

  /** 停用绑定（对应 Host 任务删除后）。 */
  deactivate(id: string): boolean {
    const result = this.db.prepare('UPDATE schedule_bindings SET active = 0, last_reconciled_at = ? WHERE id = ?').run(now(), id);
    return result.changes > 0;
  }

  /** 记录一次对账完成时间。 */
  touchReconciled(id: string): void {
    this.db.prepare('UPDATE schedule_bindings SET last_reconciled_at = ? WHERE id = ?').run(now(), id);
  }
}
