/**
 * agentPresets 预设目录适配器（FB-21：预设名不可枚举的修复）。
 *
 * 双面服务事实（0.7.6 本机探针实证）：插件 ctx.get('agentPresets') 拿到的是
 * remote-client 子集（仅 list/read/select——Host realm）；mount/compositionInventory/
 * resolve 只在 Agent 作用域（setup 回调的 agentCtx）的完整 registry 面上可用。
 * 故本适配器只用 remote 面的稳定方法：list（元数据）、read（组合 YAML——模块清单降级源）；
 * resolve 预检降级为 list 匹配；defaultId 尽力而为（缺省 preset 需调用方显式传）。
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

/** Host 面服务的最小稳定面（remote-client：list/read/select）。 */
interface AgentPresetsHostLike {
  list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>;
  read?(agentPreset: string): Promise<{ content?: string }>;
  compositionInventory?(): Promise<Array<{ id: string; isDefault: boolean; rows: Array<{ moduleName: string; enabled: boolean | 'conditional' }> }>>;
  readonly defaultId?: string;
}

/** 疑似执行类模块名特征（启发式提示，非断言——展示原始模块清单供人工判断）。 */
const EXECUTION_MODULE_HINT = /native-command|dsh-tools|bash|shell|edit|write|fs/i;

export class DshPresetCatalogAdapter {
  constructor(private readonly ctx: Context) {}

  private registry(): Promise<AgentPresetsHostLike | undefined> {
    return awaitService<AgentPresetsHostLike>(this.ctx, 'agentPresets', 2, 100).catch(() => undefined);
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

  /**
   * 各预设的插件组合清单：优先 compositionInventory（完整面），Host 面无此方法时
   * 逐预设 read(id) 解析组合 YAML 的插件行（remote 面稳定路径）。
   */
  async listCompositions(): Promise<PresetCompositionInfo[] | undefined> {
    const registry = await this.registry();
    if (registry === undefined) return undefined;
    if (typeof registry.compositionInventory === 'function') {
      try {
        const inventory = await registry.compositionInventory();
        return inventory.map((c) => ({
          id: c.id,
          isDefault: c.isDefault,
          modules: c.rows.filter((r) => r.enabled !== false).map((r) => r.moduleName),
        }));
      } catch {
        // 落入 read 降级
      }
    }
    const presets = await this.listPresets();
    if (presets === undefined) return undefined;
    const result: PresetCompositionInfo[] = [];
    for (const preset of presets) {
      const modules = await this.readModules(registry, preset.id);
      result.push({ id: preset.id, isDefault: preset.isDefault, modules });
    }
    return result;
  }

  /** read(id) 组合 YAML 中提取插件行（声明式 entry list 的 `- name: xxx` / `- xxx` 行）。 */
  private async readModules(registry: AgentPresetsHostLike, id: string): Promise<string[]> {
    if (typeof registry.read !== 'function') return [];
    try {
      const doc = await registry.read(id);
      const yaml = typeof doc === 'string' ? doc : doc?.content ?? '';
      const modules: string[] = [];
      for (const match of yaml.matchAll(/^\s*-\s*(?:name:\s*)?['"]?([@\w/.-]+)['"]?\s*$/gm)) {
        const name = match[1];
        if (name !== undefined) modules.push(name);
      }
      return modules;
    } catch {
      return [];
    }
  }

  /** 预检单个预设（存在性与激活状态；remote 面无 resolve——降级 list 匹配）。 */
  async resolvePreset(id: string): Promise<{ found: boolean; broken: string | null; name: string | null; description: string | null } | undefined> {
    const presets = await this.listPresets();
    if (presets === undefined) return undefined;
    const hit = presets.find((p) => p.id === id);
    if (hit === undefined) return { found: false, broken: null, name: null, description: null };
    return { found: true, broken: hit.broken, name: hit.name, description: hit.description };
  }

  /** 宿主默认预设 id（remote 面尽力而为；不可达返回 undefined——调用方要求显式 preset）。 */
  async defaultId(): Promise<string | undefined> {
    const registry = await this.registry();
    return registry?.defaultId;
  }

  /** 启发式：组合模块名是否疑似含执行类工具（提示性标记，非权限断言）。 */
  static executionHint(modules: string[]): boolean {
    return modules.some((m) => EXECUTION_MODULE_HINT.test(m));
  }
}
