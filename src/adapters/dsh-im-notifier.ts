/**
 * dsh-im 通知适配器（ITERATION_PLAN Phase 4——4-A）。
 * dsh-im（@xmanrui/dsh-im）无类型声明，按其《主动投递使用指南》契约建模最小结构面：
 * send(botId, targetId, text, { signal?, format? }) → { sent: boolean }。
 * 服务缺失（未安装/未就绪）或发送失败一律返回 false，由上层降级到 Router 会话。
 */
import type { Context } from '@deepseek-ai/cordis';
import { awaitService } from './host-services.js';

/** dsh-im 服务最小面（未安装时不可达）。 */
export interface DshImLike {
  send(
    botId: string,
    targetId: string,
    text: string,
    options?: { signal?: AbortSignal; format?: 'plain' | 'markdown' },
  ): Promise<{ sent: boolean }>;
  listBots?(): string[];
  listTargets?(botId: string): Promise<Array<{ targetId: string; name?: string; kind: string }>>;
}

/** 主动投递目标配置（botId + targetId 均来自 dsh-im 设置页的「复制调用参数」）。 */
export interface DshImTargetConfig {
  botId: string;
  targetId: string;
}

/** 服务解析：未安装或未就绪时返回 undefined（不抛错——上层据此降级）。 */
export class DshImNotifierAdapter {
  constructor(private readonly ctx: Context) {}

  private async service(): Promise<DshImLike | undefined> {
    try {
      return await awaitService<DshImLike>(this.ctx, 'dshIm', 2, 50);
    } catch {
      return undefined;
    }
  }

  /** 发送一条通知（成功返回 true；服务缺失/配置缺失/发送失败返回 false）。 */
  async notify(message: string, config: DshImTargetConfig): Promise<boolean> {
    const botId = config.botId.trim();
    const targetId = config.targetId.trim();
    if (botId === '' || targetId === '') return false;
    const im = await this.service();
    if (!im) return false;
    try {
      const result = await im.send(botId, targetId, message);
      return result.sent === true;
    } catch {
      return false;
    }
  }

  /** 只读列举机器人 ID（诊断与探针用，不产生任何投递）。 */
  async listBots(): Promise<string[]> {
    const im = await this.service();
    if (!im || typeof im.listBots !== 'function') return [];
    try {
      const raw = im.listBots();
      // dsh-im 文档未写明返回形态（实测非数组），此处归一化
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
}
