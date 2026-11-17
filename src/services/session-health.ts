/**
 * SessionHealth：Worker 会话空转检测（生产反馈 FB-9②③）。
 * 空转定义：会话有 turn 结束但期间无任何工具调用产出（发汇报/查状态/结束回合的循环）。
 * 检测：turn.end 计数 +1、tools/result 清零；连续超过阈值且该会话有 running 任务 → 通知 Router
 * （建议 steer 引导，或 supervisor_session_create 换新会话重派——长寿命会话行为退化的标准处置）。
 * 纯内存态（计数器），永不抛错（旁路观测，不阻断事件管线）。
 */

/** 空转告警阈值：连续无工具调用的 turn 数（缺省 2——实测空转模式为"汇报→查状态→结束"）。 */
const DEFAULT_IDLE_TURNS = 2;

/** 通知目标的最小面（notifier.notify 包装，便于测试替身）。 */
export interface HealthNotifyTarget {
  notify(message: string, severity: 'info' | 'warning' | 'critical'): Promise<boolean>;
}

/** running 任务归属查询的最小面（taskManager.tasks）。 */
export interface RunningTaskSource {
  list(options: { status: 'running' }): Array<{ id: string; assigned_session_id: string | null }>;
}

export class SessionHealth {
  /** 连续无工具调用的 turn 计数（key = sessionId）。 */
  private readonly idleTurns = new Map<string, number>();
  /** 已告警的去抖（key = sessionId，告警一次后需出现工具调用产出才重新计费）。 */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly tasks: RunningTaskSource,
    private readonly notify: HealthNotifyTarget,
    private readonly threshold = DEFAULT_IDLE_TURNS,
  ) {}

  /** 该会话产生了一次工具调用产出 → 空转计数清零、告警去抖复位。 */
  observeToolResult(sessionId: string): void {
    if (sessionId === '') return;
    this.idleTurns.delete(sessionId);
    this.alerted.delete(sessionId);
  }

  /** 该会话一个 turn 结束且期间无工具调用 → 计数；连续超阈值且有 running 任务 → 告警。 */
  async observeTurnEnd(sessionId: string): Promise<void> {
    if (sessionId === '') return;
    const count = (this.idleTurns.get(sessionId) ?? 0) + 1;
    this.idleTurns.set(sessionId, count);
    if (count < this.threshold || this.alerted.has(sessionId)) return;
    const running = this.tasks.list({ status: 'running' }).filter((t) => t.assigned_session_id === sessionId);
    if (running.length === 0) return;
    this.alerted.add(sessionId);
    await this.notify
      .notify(
        `Worker 会话 ${sessionId} 疑似空转（连续 ${count} 个回合无工具调用产出，关联运行中任务：${running.map((t) => t.id).join(', ')}）——建议 supervisor_task_steer 注入引导，或 supervisor_session_create 换新会话后重派`,
        'warning',
      )
      .catch(() => false);
  }

  /** 诊断视图（测试用）。 */
  snapshot(): Array<{ sessionId: string; idleTurns: number }> {
    return [...this.idleTurns.entries()].map(([sessionId, idleTurns]) => ({ sessionId, idleTurns }));
  }
}
