/**
 * Notifier 第一版：SessionDirectNotifier（方案 §6.8 / §3 D6）。
 * 经 Router 会话呈现：followup 唤醒 Router 转述重要事件（need_human 等），
 * 用户打开会话即见且留档于会话历史；dsh-im 推送增强后置。
 * 通知为尽力而为：失败返回 false，不阻断调用方主流程。
 */
import type { DshAgentAdapter } from '../adapters/dsh-agent.js';

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
