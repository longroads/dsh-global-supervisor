/**
 * projects 表 Repository：受管项目的唯一读写入口（SQL 收敛纪律）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectHealth, ProjectRow, ProjectStatus } from '../../types/index.js';

function now(): string {
  return new Date().toISOString();
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 新建受管项目（status/health 走默认值，时间戳自动盖章）。 */
  create(input: { id: string; workspaceId: string; name: string; description?: string; priority?: number; workerSessionId?: string }): void {
    this.db
      .prepare(
        `INSERT INTO projects(id, workspace_id, name, description, priority, status, worker_session_id, goals_json, health, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'active', ?, '[]', 'unknown', ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.name,
        input.description ?? '',
        input.priority ?? 3,
        input.workerSessionId ?? null,
        now(),
        now(),
      );
  }

  byId(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  byWorkspaceId(workspaceId: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE workspace_id = ?').get(workspaceId) as ProjectRow | undefined;
  }

  list(includeArchived = false): ProjectRow[] {
    const sql = includeArchived ? 'SELECT * FROM projects' : "SELECT * FROM projects WHERE status <> 'archived'";
    return this.db.prepare(sql).all() as unknown as ProjectRow[];
  }

  /** 白名单字段更新，updated_at 自动盖章。 */
  update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      priority?: number;
      status?: ProjectStatus;
      workerSessionId?: string | null;
      goalsJson?: string;
      health?: ProjectHealth;
      lastReviewAt?: string | null;
      nextReviewAt?: string | null;
    },
  ): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
    if (patch.priority !== undefined) { sets.push('priority = ?'); params.push(patch.priority); }
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.workerSessionId !== undefined) { sets.push('worker_session_id = ?'); params.push(patch.workerSessionId); }
    if (patch.goalsJson !== undefined) { sets.push('goals_json = ?'); params.push(patch.goalsJson); }
    if (patch.health !== undefined) { sets.push('health = ?'); params.push(patch.health); }
    if (patch.lastReviewAt !== undefined) { sets.push('last_review_at = ?'); params.push(patch.lastReviewAt); }
    if (patch.nextReviewAt !== undefined) { sets.push('next_review_at = ?'); params.push(patch.nextReviewAt); }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(id);
    const result = this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return result.changes > 0;
  }

  /** 归档：仅置状态，不触碰 DSH workspace 注册与历史数据。 */
  archive(id: string): boolean {
    return this.update(id, { status: 'archived' });
  }
}
