/**
 * event_routing_rules 表 Repository：事件路由规则（Phase 2 简化 Eval 的 Gate 层）。
 * 匹配键约定 `${source}.${type}`（如 webhook.issue.opened、agent.user.message）；
 * 模式支持精确匹配、尾缀 `.*` 前缀通配与裸 `*` 全量通配。
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from '../../utils/id.js';

function now(): string {
  return new Date().toISOString();
}

export type EventRoutingAction = 'route_to_router' | 'route_to_worker' | 'ignore' | 'observe';

/** event_routing_rules 表行。 */
export interface EventRoutingRuleRow {
  id: string;
  source_pattern: string;
  action: EventRoutingAction;
  target_session_id: string | null;
  description: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** 模式匹配：精确 / 尾缀 .* 前缀 / 裸 * 全量。 */
export function patternMatches(pattern: string, matchKey: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return matchKey.startsWith(pattern.slice(0, -1));
  return pattern === matchKey;
}

export class EventRoutingRuleRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 保存或更新规则（同 source_pattern 覆盖）。 */
  async save(input: { sourcePattern: string; action: EventRoutingAction; targetSessionId?: string; description?: string; enabled?: boolean }): Promise<EventRoutingRuleRow> {
    const existing = this.db.prepare('SELECT id FROM event_routing_rules WHERE source_pattern = ?').get(input.sourcePattern) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE event_routing_rules SET action = ?, target_session_id = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(input.action, input.targetSessionId ?? null, input.description ?? '', input.enabled === false ? 0 : 1, now(), existing.id);
      return this.byId(existing.id) as EventRoutingRuleRow;
    }
    const id = `evrule-${(await randomUUID()).slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO event_routing_rules(id, source_pattern, action, target_session_id, description, enabled, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.sourcePattern, input.action, input.targetSessionId ?? null, input.description ?? '', input.enabled === false ? 0 : 1, now(), now());
    return this.byId(id) as EventRoutingRuleRow;
  }

  /** 按事件匹配键取第一条启用规则（rowid 即保存顺序——先保存者优先）。 */
  match(source: string, type: string): EventRoutingRuleRow | undefined {
    const matchKey = `${source}.${type}`;
    const rows = this.db.prepare('SELECT * FROM event_routing_rules WHERE enabled = 1 ORDER BY rowid').all() as unknown as EventRoutingRuleRow[];
    return rows.find((row) => patternMatches(row.source_pattern, matchKey));
  }

  /** 全量规则（含禁用，按保存顺序）。 */
  list(): EventRoutingRuleRow[] {
    return this.db.prepare('SELECT * FROM event_routing_rules ORDER BY rowid').all() as unknown as EventRoutingRuleRow[];
  }

  private byId(id: string): EventRoutingRuleRow | undefined {
    return this.db.prepare('SELECT * FROM event_routing_rules WHERE id = ?').get(id) as EventRoutingRuleRow | undefined;
  }
}
