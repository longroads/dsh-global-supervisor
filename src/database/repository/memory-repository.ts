/**
 * memories 表 Repository（0.7.2 记忆地基）：四类记忆的存取与开放回路闭环。
 * category ∈ preference（偏好）/ fact（事实）/ routine（惯例）/ commitment（承诺，开放回路）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRow } from '../../types/index.js';
import { randomUUID } from '../../utils/id.js';

function now(): string {
  return new Date().toISOString();
}

/** 记忆类别（与迁移 v8 的 CHECK 约束一致）。 */
export const MEMORY_CATEGORIES = ['preference', 'fact', 'routine', 'commitment'] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export class MemoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 新建一条记忆（同 category+content 幂等：已存在返回既有行）。 */
  async save(input: { category: MemoryCategory; content: string; source?: string }): Promise<MemoryRow> {
    const existing = this.db
      .prepare('SELECT * FROM memories WHERE category = ? AND content = ? AND closed = 0')
      .get(input.category, input.content) as MemoryRow | undefined;
    if (existing) return existing;
    const id = `mem-${(await randomUUID()).slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO memories(id, category, content, source, closed, created_at, updated_at) VALUES(?, ?, ?, ?, 0, ?, ?)')
      .run(id, input.category, input.content, input.source ?? 'router', now(), now());
    return this.byId(id) as MemoryRow;
  }

  /** 按 id 闭环（commitment 开放回路关闭）。 */
  close(id: string): boolean {
    const result = this.db.prepare('UPDATE memories SET closed = 1, updated_at = ? WHERE id = ?').run(now(), id);
    return result.changes > 0;
  }

  /** 查询（category 可选过滤；默认只含未闭环，includeClosed=true 含全部）。 */
  list(category?: MemoryCategory, includeClosed = false): MemoryRow[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (category !== undefined) { conditions.push('category = ?'); params.push(category); }
    if (!includeClosed) conditions.push('closed = 0');
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM memories${where} ORDER BY updated_at DESC`).all(...params) as unknown as MemoryRow[];
  }

  /** 未闭环承诺数（简报的开放回路段）。 */
  openCommitmentCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE category = 'commitment' AND closed = 0").get() as { n: number };
    return row.n;
  }

  private byId(id: string): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  }
}
