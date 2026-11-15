/**
 * llm 服务目录适配器（Phase 6 6-B）：模型清单枚举与入参校验的唯一触达点。
 * 目录不可达（服务未就绪）返回 undefined——调用方按"免校验直填"降级，不阻断功能。
 */
import type { Context } from '@deepseek-ai/cordis';
import { awaitService } from './host-services.js';

/** 目录条目（provider × 其可通告模型）。 */
export interface LlmCatalogEntry {
  provider: string;
  providerName: string;
  models: Array<{ id: string; name: string }>;
}

/** llm 服务最小面（dsh-llm LlmRuntime 的目录侧）。 */
interface LlmCatalogLike {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
}

export class DshLlmCatalogAdapter {
  constructor(private readonly ctx: Context) {}

  /** 全量目录；服务不可达返回 undefined（降级信号，非错误）。 */
  async list(): Promise<LlmCatalogEntry[] | undefined> {
    let llm: LlmCatalogLike;
    try {
      llm = await awaitService<LlmCatalogLike>(this.ctx, 'llm', 2, 50);
    } catch {
      return undefined;
    }
    const entries: LlmCatalogEntry[] = [];
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id);
        entries.push({ provider: provider.id, providerName: provider.name, models: models.map((m) => ({ id: m.id, name: m.name })) });
      } catch {
        entries.push({ provider: provider.id, providerName: provider.name, models: [] });
      }
    }
    return entries;
  }

  /** 校验 provider/model 在目录中；目录不可达时放行并标注 catalogChecked:false。 */
  async validate(provider: string, model: string): Promise<{ ok: boolean; reason?: string; catalogChecked: boolean }> {
    const catalog = await this.list();
    if (catalog === undefined) return { ok: true, catalogChecked: false };
    const entry = catalog.find((e) => e.provider === provider);
    if (entry === undefined) return { ok: false, reason: `provider 不在 llm 目录：${provider}（supervisor_model_list 可查全量）`, catalogChecked: true };
    if (!entry.models.some((m) => m.id === model)) return { ok: false, reason: `model 不在 ${provider} 目录：${model}`, catalogChecked: true };
    return { ok: true, catalogChecked: true };
  }
}
