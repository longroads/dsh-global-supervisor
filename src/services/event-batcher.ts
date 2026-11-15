/**
 * EventBatcher：事件批处理注入（ITERATION_PLAN Phase 5-A，借鉴 TianzeLuo）。
 * Router 侧降噪：route_to_router 命中的事件先积累，防抖窗口内合批为一条 followup；
 * Router 忙时延后（不丢），派发失败回填重试，批渲染带字符预算与召回提示。
 */
import type { EventRow } from '../types/index.js';

/** 派发目标（DshAgentAdapter 的最小面：dispatch + 可选忙判定）。 */
export interface BatchDispatchTarget {
  dispatch(sessionId: string, text: string): Promise<void>;
  isBusy?(sessionId: string): Promise<boolean>;
}

/** 批处理选项（均有缺省）。 */
export interface EventBatchOptions {
  maxBatch?: number;
  maxChars?: number;
  debounceMs?: number;
}

const DEFAULT_MAX_BATCH = 20;
const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_DEBOUNCE_MS = 500;
/** 单条事件摘要的 inline 上限（借鉴 TianzeLuo inlineChars）。 */
const INLINE_CHARS = 280;

export class EventBatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly pending: EventRow[] = [];
  private readonly maxBatch: number;
  private readonly maxChars: number;
  private readonly debounceMs: number;

  constructor(
    private readonly agents: BatchDispatchTarget,
    private readonly routerSession: () => string,
    options: EventBatchOptions = {},
    /** 批派发失败回调（审计留痕用；批本身已回填待重试）。 */
    private readonly onFlushError?: (error: unknown, batchSize: number) => void,
  ) {
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** 事件到达：满批即发，否则进入防抖窗口。 */
  add(event: EventRow): void {
    this.pending.push(event);
    if (this.pending.length >= this.maxBatch) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.armTimer();
    }
  }

  /** 立即合批发送：Router 忙则延后；失败回填 pending 并重试（at-least-once）。 */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.pending.length === 0) return;
    const session = this.routerSession();
    if (this.agents.isBusy !== undefined && await this.agents.isBusy(session)) {
      this.armTimer();
      return;
    }
    const batch = this.pending.splice(0, this.maxBatch);
    try {
      await this.agents.dispatch(session, this.renderBatch(batch, this.maxChars));
    } catch (error) {
      this.pending.unshift(...batch);
      this.armTimer();
      this.onFlushError?.(error, batch.length);
    }
  }

  /** 积压数量（诊断/测试）。 */
  pendingCount(): number {
    return this.pending.length;
  }

  /** 停止定时器（插件卸载语义；未发批次留在内存由进程生命周期承担）。 */
  stop(): void {
    this.clearTimer();
  }

  private armTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 渲染一批事件为结构化文本（每条 inline 摘要 + 字符预算 + 召回提示）。 */
  private renderBatch(batch: EventRow[], maxChars: number): string {
    const header = `【supervisor 事件批】共 ${batch.length} 条`;
    const footer = '需完整上下文可用 supervisor_recall（按 event_id/task_id 召回关联任务、汇报与执行历史）。';
    const budget = maxChars - header.length - footer.length;
    const lines: string[] = [];
    let used = 0;
    for (const event of batch) {
      const summary = event.payload_json.slice(0, INLINE_CHARS);
      const line = `- ${event.event_id} [${event.source}/${event.type}] ${summary}`;
      if (used + line.length > budget && lines.length > 0) {
        lines.push('…（超出字符预算，余下事件留待下一批或经 supervisor_recall 查询）');
        break;
      }
      lines.push(line);
      used += line.length;
    }
    return [header, ...lines, '', footer].join('\n');
  }
}
