/**
 * ModelQueue：本插件发起的 Worker 唤醒并发控制（DEVELOPMENT_PLAN §6.7）。
 * 语义边界：只约束本插件自己发起的派发，不拦截 DSH 全部 LLM 请求。
 * 默认并发 1（本地推理资源敏感）；高优先级插队不抢占已开始的执行。
 */
/** 一个排队/执行中的任务句柄。 */
export interface QueueJob {
  /** 业务标识（通常是 taskId），用于诊断与去重 */
  id: string;
  /** 优先级 0-9，越大越先出队；同级 FIFO */
  priority: number;
}

/** 获得许可后交还的句柄。 */
export interface ReleaseHandle {
  /** 释放许可，队列自动放行下一个任务。幂等。 */
  release(): void;
  /** 该任务是否当前持有许可。 */
  readonly held: boolean;
}

/** 队列统计（诊断与测试）。 */
export interface QueueStats {
  running: number;
  waiting: number;
}

interface WaitingEntry {
  job: QueueJob;
  grant: (handle: ReleaseHandle) => void;
  seq: number;
  cancelled: boolean;
}

/** 优先级许可队列（同进程内存态，不持久化——Host 重启后任务恢复由 TaskManager 存疑恢复负责）。 */
export class ModelQueue {
  private readonly waiting: WaitingEntry[] = [];
  private running = 0;
  private seq = 0;

  constructor(private readonly maxConcurrency = 1) {
    if (maxConcurrency < 1 || !Number.isInteger(maxConcurrency)) {
      throw new Error(`maxConcurrency 必须是正整数：${maxConcurrency}`);
    }
  }

  /**
   * 提交任务并等待许可：有空位立即获得；否则按优先级排队。
   * @param job 任务描述
   * @returns 许可句柄（release 后放行后续）
   */
  submit(job: QueueJob): Promise<ReleaseHandle> {
    return new Promise((resolve) => {
      this.waiting.push({ job, grant: resolve, seq: this.seq++, cancelled: false });
      this.waiting.sort((a, b) => b.job.priority - a.job.priority || a.seq - b.seq);
      this.pump();
    });
  }

  /**
   * 取消某任务的全部排队项（FB-18 许可黑洞）：等待超时后放弃排队，
   * 迟到的许可（race 竞态下恰好放行）由调用方 release 归还。
   * @returns 是否有排队项被取消（false = 已持许可或不在队列）
   */
  cancel(jobId: string): boolean {
    let cancelled = false;
    for (const entry of this.waiting) {
      if (entry.job.id === jobId && !entry.cancelled) {
        entry.cancelled = true;
        cancelled = true;
      }
    }
    return cancelled;
  }

  /** 当前队列状态。 */
  stats(): QueueStats {
    return { running: this.running, waiting: this.waiting.length };
  }

  private pump(): void {
    while (this.running < this.maxConcurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (!entry || entry.cancelled) continue;
      this.running += 1;
      const handle = this.createHandle(entry);
      entry.grant(handle);
    }
  }

  private createHandle(entry: WaitingEntry): ReleaseHandle {
  let held = true;
  const queue = this;
  return {
    get held() { return held; },
    release(): void {
      if (!held) return;
      held = false;
      queue.running -= 1;
      queue.pump();
    },
  };
}
}
