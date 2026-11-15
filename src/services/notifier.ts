/**
 * Notifier（方案 §6.8 / §3 D6 + ITERATION_PLAN Phase 4 4-B）：
 * - SessionDirectNotifier：经 Router 会话呈现（followup 唤醒 Router 转述）；
 * - NotifierService：路由层——优先 IM（dsh-im），失败降级 Router 会话（通知尽力而为）。
 */
import type { DshAgentAdapter } from '../adapters/dsh-agent.js';
import type { DshImNotifierAdapter, DshImTargetConfig } from '../adapters/dsh-im-notifier.js';

export class SessionDirectNotifier {
  constructor(
    private readonly agents: DshAgentAdapter,
    /** Router 代表会话解析（认领制下动态读取，见 RouterIdentity.ownerSessionId） */
    private readonly resolveOwnerSession: () => string,
  ) {}

  /** 唤醒 Router 会话转述一条通知。 */
  async notify(message: string): Promise<boolean> {
    try {
      await this.agents.dispatch(this.resolveOwnerSession(), `【supervisor 通知】${message}`);
      return true;
    } catch {
      return false;
    }
  }
}

/** 通知级别（决定前缀与语义）。 */
export type NotifySeverity = 'info' | 'warning' | 'critical';

/** 通知路由配置（plugin config.notifier）。 */
export interface NotifierConfig extends DshImTargetConfig {
  /** 'session'（默认，仅 Router 会话）| 'dsh-im'（优先 IM，失败降级会话） */
  type: 'session' | 'dsh-im';
}

/** 级别前缀（单次施加，避免各通道重复标注）。 */
const SEVERITY_PREFIX: Record<NotifySeverity, string> = {
  info: '【通知】',
  warning: '【警告】',
  critical: '【严重】',
};

/** 会话通知目标（SessionDirectNotifier 的最小面，便于测试替身）。 */
export interface SessionNotifyTarget {
  notify(message: string): Promise<boolean>;
}

/** IM 通知目标（DshImNotifierAdapter 的最小面，便于测试替身）。 */
export interface ImNotifyTarget {
  notify(message: string, config: DshImTargetConfig): Promise<boolean>;
}

/**
 * 通知路由层：type='dsh-im' 且配置了 botId 时先走 IM；
 * IM 不可用（未安装/Bot 离线/发送失败）一律降级到 Router 会话，不阻断调用方。
 */
export class NotifierService {
  constructor(
    private readonly sessionNotifier: SessionNotifyTarget,
    private readonly imNotifier: ImNotifyTarget,
    private readonly config: NotifierConfig,
  ) {}

  /** 发送一条通知（返回是否送达任一通道）。 */
  async notify(message: string, severity: NotifySeverity = 'info'): Promise<boolean> {
    const text = `${SEVERITY_PREFIX[severity]} ${message}`;
    if (this.config.type === 'dsh-im' && this.config.botId.trim() !== '') {
      const sent = await this.imNotifier.notify(text, { botId: this.config.botId, targetId: this.config.targetId });
      if (sent) return true;
    }
    return this.sessionNotifier.notify(text);
  }
}
