/**
 * EventManager：统一事件入口（DEVELOPMENT_PLAN §6.4）。
 * ingest → event_id 唯一约束去重（Schedule 非恰好一次投递的兜底）→ 落库 → 按规则表路由。
 * handler 抛错不互相阻断，错误收集后返回调用方。
 */
import type { DatabaseSync } from 'node:sqlite';
import { EventRepository } from '../database/repository/event-repository.js';
import type { EventRow, EventSource } from '../types/index.js';

/** 事件输入（调用方构造；eventId 由来源保证唯一且稳定）。 */
export interface SupervisorEventInput {
  eventId: string;
  source: EventSource;
  type: string;
  workspaceId?: string;
  taskId?: string;
  payloadJson?: string;
  dedupHash?: string;
}

/** 事件处理器。 */
export type EventHandler = (event: EventRow) => void | Promise<void>;

/** ingest 的结构化结果。 */
export interface IngestResult {
  /** true 表示新事件已落库；false 表示重复被去重 */
  inserted: boolean;
  /** 实际派发的 handler 数 */
  dispatched: number;
  /** handler 抛出的错误（原样收集） */
  errors: unknown[];
}

/** 事件管理器（内存态路由表 + events 表持久化）。 */
export class EventManager {
  readonly repository: EventRepository;
  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(private readonly db: DatabaseSync) {
    this.repository = new EventRepository(db);
  }

  /** 注册处理器：type 精确匹配，或以 `.*` 结尾的前缀匹配（如 `schedule.*`）。 */
  on(pattern: string, handler: EventHandler): void {
    const list = this.handlers.get(pattern) ?? [];
    list.push(handler);
    this.handlers.set(pattern, list);
  }

  /**
   * 写入并路由一个事件：重复 event_id 直接短路（不派发）。
   */
  async ingest(event: SupervisorEventInput): Promise<IngestResult> {
    const inserted = this.repository.ingest({
      eventId: event.eventId,
      source: event.source,
      type: event.type,
      workspaceId: event.workspaceId,
      taskId: event.taskId,
      payloadJson: event.payloadJson,
      dedupHash: event.dedupHash,
    });
    if (!inserted) {
      return { inserted: false, dispatched: 0, errors: [] };
    }
    const row = this.repository.byEventId(event.eventId);
    if (!row) {
      return { inserted: true, dispatched: 0, errors: [new Error('事件落库后不可读')] };
    }
    const matched = this.matchingHandlers(row.type);
    const errors: unknown[] = [];
    for (const handler of matched) {
      try {
        await handler(row);
      } catch (error) {
        errors.push(error);
      }
    }
    return { inserted: true, dispatched: matched.length, errors };
  }

  /** 按 type 匹配的 handler 列表（精确 + 前缀通配）。 */
  private matchingHandlers(type: string): EventHandler[] {
    const result: EventHandler[] = [];
    for (const [pattern, list] of this.handlers) {
      if (pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)))) {
        result.push(...list);
      }
    }
    return result;
  }
}
