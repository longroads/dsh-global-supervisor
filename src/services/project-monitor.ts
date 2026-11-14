/**
 * ProjectMonitor：超时看门狗（方案 §6.6）。
 * 周期扫描 running 且超时窗口已过的任务：判 failed/timeout 并按重试策略重排；
 * 扫描逻辑复用 TaskManager.recoverFromRestart（同一超时语义，幂等）。
 * 定时经全局 setInterval（沙箱 timer 服务需 inject 声明，第一版规避），
 * stop() 显式清理，插件卸载语义由宿主进程生命周期承担。
 */
import type { AgentController } from './agent-controller.js';
import type { TaskManager } from './task-manager.js';

/** 单次扫描结果（机器消费值）。 */
export interface WatchdogScan {
  expired: string[];
  retried: string[];
  retryExhausted: string[];
  permitsReleased: number;
}

/** 默认扫描间隔：5 分钟。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class ProjectMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly agentController: AgentController,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  /** 启动周期扫描。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.intervalMs);
  }

  /** 停止扫描（幂等）。 */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 扫描一次：超时任务判 failed/timeout；重试预算未尽的任务重排入队。
   * recoverFromRestart 即超时判定本体（超时窗口已过 → failed/timeout，幂等）。
   * 重排前先释放该任务的并发许可——否则重排后的新派发将永久等待（许可泄漏即队列死锁）。
   */
  scanOnce(): WatchdogScan {
    const result: WatchdogScan = { expired: [], retried: [], retryExhausted: [], permitsReleased: 0 };
    const recovery = this.taskManager.recoverFromRestart();
    result.expired = recovery.expiredIds;
    for (const taskId of recovery.expiredIds) {
      if (this.agentController.releasePermit(taskId)) {
        result.permitsReleased += 1;
      }
      try {
        this.taskManager.retry(taskId, { role: 'system' });
        result.retried.push(taskId);
      } catch {
        result.retryExhausted.push(taskId);
      }
    }
    return result;
  }
}
