/**
 * events 表 Repository：统一事件流水。event_id 唯一约束实现去重
 * （Schedule 非恰好一次投递的兜底，见 DEVELOPMENT_PLAN §6.5/§8）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EventRow, EventSource } from '../../types/index.js';

function now(): string {
  return new Date().toISOString();
}

export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 写入事件：event_id 重复时静默忽略。
   * @returns true 表示新写入；false 表示重复（已存在，去重生效）
   */
  ingest(input: {
    eventId: string;
    source: EventSource;
    type: string;
    workspaceId?: string;
    taskId?: string;
    payloadJson?: string;
    dedupHash?: string;
    threadId?: string;
    channelRef?: string;
    actorJson?: string;
    human?: boolean;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events(event_id, source, type, workspace_id, task_id, payload_json, dedup_hash, thread_id, channel_ref, actor_json, human, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.source,
        input.type,
        input.workspaceId ?? null,
        input.taskId ?? null,
        input.payloadJson ?? '{}',
        input.dedupHash ?? null,
        input.threadId ?? null,
        input.channelRef ?? null,
        input.actorJson ?? null,
        input.human ? 1 : 0,
        now(),
      );
    return result.changes > 0;
  }

  byEventId(eventId: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as EventRow | undefined;
  }

  listRecent(limit: number): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as EventRow[];
  }

  /** 按来源过滤的最近事件（source 缺省不过滤）。 */
  listFiltered(source: string | undefined, limit: number): EventRow[] {
    if (source === undefined) return this.listRecent(limit);
    return this.db.prepare('SELECT * FROM events WHERE source = ? ORDER BY id DESC LIMIT ?').all(source, limit) as unknown as EventRow[];
  }

  /** 同 Thread 的最近事件（召回用，按 id 倒序）。 */
  byThread(threadId: string, limit: number): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit) as unknown as EventRow[];
  }

  countByType(type: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number };
    return row.n;
  }
}
