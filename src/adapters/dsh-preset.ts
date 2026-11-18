/**
 * agentPresets 预设目录适配器（FB-21①：预设名不可枚举的修复）。
 * 宿主 dsh-agent-preset-registry 提供 list（全量预设元数据）与
 * compositionInventory（每预设的插件行清单——判断是否含执行类模块的唯一依据）。
 * 服务可能因 cordis group 隔离对本插件不可见（README 隔离警告）——
 * 全部调用降级返回 undefined，调用方提示人工确认，不阻断工具。
 */
import type { Context } from '@deepseek-ai/cordis';
import { awaitService } from './host-services.js';

/** 预设元数据（AgentPreset 的纯数据视图）。 */
export interface PresetInfo {
  id: string;
  name: string | null;
  description: string | null;
  broken: string | null;
  isDefault: boolean;
}

/** 预设组合清单（moduleName 列表——Router/用户据此判断工具集）。 */
export interface PresetCompositionInfo {
  id: string;
  isDefault: boolean;
  modules: string[];
}

/** agentPresets 服务最小面（dsh-agent-preset-registry AgentPresetRegistry）。 */
interface AgentPresetsLike {
  list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>;
  compositionInventory(): Promise<Array<{ id: string; isDefault: boolean; rows: Array<{ moduleName: string; enabled: boolean | 'conditional' }> }>>;
  resolve(id?: string): Promise<{ id: string; name?: string; description?: string; broken?: string }>;
  readonly defaultId: string;
}

/** 疑似执行类模块名特征（启发式提示，非断言——展示原始模块清单供人工判断）。 */
const EXECUTION_MODULE_HINT = /native-command|dsh-tools|bash|shell|edit|write|fs/i;

export class DshPresetCatalogAdapter {
  constructor(private readonly ctx: Context) {}

  private registry(): Promise<AgentPresetsLike | undefined> {
    return awaitService<AgentPresetsLike | undefined>(this.ctx, 'agentPresets', 2, 100).catch(() => undefined);
  }

  /** 全量预设；服务不可达返回 undefined（降级信号）。 */
  async listPresets(): Promise<PresetInfo[] | undefined> {
    const registry = await this.registry();
    if (registry === undefined) return undefined;
    try {
      const presets = await registry.list();
      return presets.map((p) => ({
        id: p.id,
        name: p.name ?? null,
        description: p.description ?? null,
        broken: p.broken ?? null,
        isDefault: p.id === registry.defaultId,
      }));
    } catch {
      return undefined;
    }
  }

  /** 各预设的插件组合清单；服务不可达返回 undefined。 */
  async listCompositions(): Promise<PresetCompositionInfo[] | undefined> {
    const registry = await this.registry();
    if (registry === undefined) return undefined;
    try {
      const inventory = await registry.compositionInventory();
      return inventory.map((c) => ({
        id: c.id,
        isDefault: c.isDefault,
        modules: c.rows.filter((r) => r.enabled !== false).map((r) => r.moduleName),
      }));
    } catch {
      return undefined;
    }
  }

  /** 预检单个预设（存在性与激活状态；不存在/服务不可达返回 undefined，broken 返回原因）。 */
  async resolvePreset(id: string): Promise<{ found: boolean; broken: string | null; name: string | null; description: string | null } | undefined> {
    const registry = await this.registry();
    if (registry === undefined) return undefined;
    try {
      const preset = await registry.resolve(id);
      return { found: true, broken: preset.broken ?? null, name: preset.name ?? null, description: preset.description ?? null };
    } catch {
      return { found: false, broken: null, name: null, description: null };
    }
  }

  /** 宿主默认预设 id（服务不可达返回 undefined）。 */
  async defaultId(): Promise<string | undefined> {
    const registry = await this.registry();
    return registry?.defaultId;
  }

  /** 启发式：组合模块名是否疑似含执行类工具（提示性标记，非权限断言）。 */
  static executionHint(modules: string[]): boolean {
    return modules.some((m) => EXECUTION_MODULE_HINT.test(m));
  }
}
