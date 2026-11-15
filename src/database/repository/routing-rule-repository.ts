/**
 * routing_rules 表 Repository：工作区路由偏好（用户说"k8s 给 research 执行"→ 保存规则 → 之后自动匹配）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RoutingRuleRow } from '../../types/index.js';
import { randomUUID } from '../../utils/id.js';

function now(): string {
  return new Date().toISOString();
}

export class RoutingRuleRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 保存或更新路由规则（同 keyword 覆盖，命中数保留）。 */
  async save(input: { keyword: string; workspaceId: string; createdBy?: string; note?: string }): Promise<RoutingRuleRow> {
    const existing = this.db.prepare('SELECT id FROM routing_rules WHERE keyword = ? AND enabled = 1').get(input.keyword) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE routing_rules SET workspace_id = ?, note = ?, created_by = ? WHERE id = ?')
        .run(input.workspaceId, input.note ?? '', input.createdBy ?? 'user', existing.id);
      return this.byId(existing.id) as RoutingRuleRow;
    }
    const id = `rule-${(await randomUUID()).slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO routing_rules(id, keyword, workspace_id, created_by, note, hit_count, enabled, created_at) VALUES(?, ?, ?, ?, ?, 0, 1, ?)')
      .run(id, input.keyword, input.workspaceId, input.createdBy ?? 'user', input.note ?? '', now());
    return this.byId(id) as RoutingRuleRow;
  }

  /** 关键词匹配（enabled=1、keyword 为 text 子串、按 hit_count 降序）。 */
  lookup(text: string): RoutingRuleRow[] {
    const lower = text.toLowerCase();
    const rows = this.db
      .prepare('SELECT * FROM routing_rules WHERE enabled = 1 ORDER BY hit_count DESC')
      .all() as unknown as RoutingRuleRow[];
    return rows.filter((row) => lower.includes(row.keyword.toLowerCase()));
  }

  /** 关键词匹配并记录命中（返回行 hit_count 已递增）。 */
  lookupAndRecord(text: string): RoutingRuleRow[] {
    const matched = this.lookup(text);
    for (const row of matched) this.incrementHit(row.id);
    return matched.map((row) => ({ ...row, hit_count: row.hit_count + 1 }));
  }

  /** 递增命中计数。 */
  incrementHit(id: string): void {
    this.db.prepare('UPDATE routing_rules SET hit_count = hit_count + 1 WHERE id = ?').run(id);
  }

  /** 停用规则。 */
  disable(id: string): boolean {
    const result = this.db.prepare('UPDATE routing_rules SET enabled = 0 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** 全量规则（含禁用）。 */
  list(): RoutingRuleRow[] {
    return this.db.prepare('SELECT * FROM routing_rules ORDER BY created_at DESC').all() as unknown as RoutingRuleRow[];
  }

  private byId(id: string): RoutingRuleRow | undefined {
    return this.db.prepare('SELECT * FROM routing_rules WHERE id = ?').get(id) as RoutingRuleRow | undefined;
  }
}
