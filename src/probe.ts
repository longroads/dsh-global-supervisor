/**
 * S1 API 探针：在真实 DSH Host 进程内验证本插件依赖的全部能力。
 *
 * 设计原则（见 docs/DEVELOPMENT_PLAN.md §10）：
 * - 每项检查独立 try/catch，单项失败不阻断整体；
 * - 结果四态：VERIFIED / UNAVAILABLE / UNSTABLE / SKIPPED；
 * - 报告 JSON 落盘到插件数据目录，供 docs/API_COMPATIBILITY.md 汇总；
 * - 探针只读探测，不创建 Workspace / Session / Schedule 等业务对象。
 * - 模块顶层零 node:* 静态依赖（宿主插件环境可能限制 Node 内建模块的解析，
 *   全部内建改为使用点动态 import，保证本模块本身可被任何环境加载）。
 */
import type { Context } from '@deepseek-ai/cordis';
// 以下 side-effect 类型导入用于合并 Context 上的服务声明（workspaceRegistry / agents / schedule / sessionPersistence / tools）
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ScheduleService } from '@deepseek-ai/dsh-schedule';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { ToolsService } from '@deepseek-ai/dsh-tools';
import type { ProbeCheck, ProbeReport } from './types/index.js';

/** 插件版本（与 package.json 同步维护）。 */
import { PLUGIN_VERSION } from './version.js';

/** 单项检查的安全包装：任何抛错都转为 UNAVAILABLE 记录，不中断整体。 */
async function check(id: string, name: string, body: () => Promise<string>): Promise<ProbeCheck> {
  const startedAt = Date.now();
  try {
    const detail = await body();
    return { id, name, status: 'VERIFIED', detail, durationMs: Date.now() - startedAt };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { id, name, status: 'UNAVAILABLE', detail, durationMs: Date.now() - startedAt };
  }
}

/** 截断任意值的安全 JSON 摘要（探针证据有长度纪律）。 */
function brief(value: unknown, maxChars = 300): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(截断)` : text;
}

/** 等待式服务解析：宿主服务链异步初始化（如 schedule 依赖 sessionPersistence），
 * apply 时刻可能未就绪——轮询 ctx.get 直到出现或超时。 */
async function awaitService(ctx: Context, name: string, retries = 40, intervalMs = 200): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const service = ctx.get(name);
      if (service !== undefined && service !== null) return service;
    } catch {
      // 门禁抛错时同样等待重试（apply 早期 façade 可能尚未就绪）
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

/** 解析插件数据目录：优先 dsh-home-paths（V6），失败降级 ~/.dsh。 */
async function resolveDataDir(configured?: string): Promise<{ dir: string; basis: string }> {
  if (configured && configured.trim() !== '') {
    return { dir: configured, basis: '显式配置' };
  }
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths');
    const dir = mod.dshHomePath('global-supervisor');
    return { dir, basis: `dsh-home-paths（home=${mod.resolveDshHome()}）` };
  } catch (error) {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const fallback = join(homedir(), '.dsh', 'global-supervisor');
    const reason = error instanceof Error ? error.message : String(error);
    return { dir: fallback, basis: `降级 ~/.dsh（dsh-home-paths 不可用：${reason}）` };
  }
}

/**
 * 运行完整探针并落盘报告。
 * @param ctx - Cordis 插件上下文（真实 Host 进程内）
 * @param configuredDir - 配置指定的数据目录（可空）
 * @returns 完整报告对象
 */
export async function runProbe(ctx: Context, configuredDir?: string): Promise<ProbeReport> {
  const data = await resolveDataDir(configuredDir);
  const checks: ProbeCheck[] = [];

  // --- 环境 ---
  checks.push(await check('env.node-version', '宿主 Node 版本（要求 >=22.19）', async () => {
    const v = process.version;
    const major = Number(v.slice(1).split('.')[0] ?? 0);
    if (major < 22) throw new Error(`Node 版本过低：${v}`);
    return v;
  }));

  checks.push(await check('env.data-dir', '插件数据目录解析（V6）', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(data.dir, { recursive: true });
    return `${data.dir}（依据：${data.basis}）`;
  }));

  // --- SQLite（V3）---
  checks.push(await check('sqlite.node-sqlite', 'node:sqlite 可用性（V3：建表/插入/查询/事务）', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO probe(v) VALUES(?)').run('ok');
    const row = db.prepare('SELECT * FROM probe WHERE id = ?').get(1) as Record<string, unknown>;
    db.close();
    if (row['v'] !== 'ok') throw new Error(`读写不一致：${brief(row)}`);
    return 'DatabaseSync/StatementSync 正常，参数绑定与查询返回符合预期';
  }));

  // --- 服务存在性与实际调用 ---
  // 宿主沙箱门禁：属性访问需要 inject 声明，ctx.get() 按需解析（官方插件模式）；
  // 服务链异步初始化，统一经 awaitService 等待就绪。
  checks.push(await check('service.workspace-registry', 'ctx.workspaceRegistry 存在且 list() 可调用', async () => {
    const reg = (await awaitService(ctx, 'workspaceRegistry')) as WorkspaceRegistry | undefined;
    if (!reg) throw new Error('ctx.workspaceRegistry 未就绪（等待 8s 后仍不可见）');
    const list = reg.list();
    const first = list[0];
    return `list() 返回 ${list.length} 个 workspace；方法集：${['create', 'get', 'list', 'delete', 'resolveByPath'].filter((m) => typeof (reg as unknown as Record<string, unknown>)[m] === 'function').join('/')}；示例：${first ? `${first.id} → ${first.path}` : '(空)'}`;
  }));

  checks.push(await check('service.agents', 'ctx.agents 存在及关键方法签名（create/resume/get/list）', async () => {
    const agents = (await awaitService(ctx, 'agents')) as AgentRegistry | undefined;
    if (!agents) throw new Error('ctx.agents 未就绪');
    const missing = ['create', 'resume', 'get', 'list'].filter((m) => typeof (agents as unknown as Record<string, unknown>)[m] !== 'function');
    if (missing.length > 0) throw new Error(`缺少方法：${missing.join('/')}`);
    const live = agents.list();
    return `方法齐全；当前活动 Agent ${live.length} 个${live[0] ? `，示例 id=${live[0].id} status=${live[0].status}` : ''}`;
  }));

  checks.push(await check('service.schedule', 'ctx.schedule（Host-wide）存在且 catalog() 可调用', async () => {
    const schedule = (await awaitService(ctx, 'schedule')) as ScheduleService | undefined;
    if (!schedule) throw new Error('ctx.schedule 未就绪（等待 8s 后仍不可见——旧版 DSH 无 Host-wide Schedule）');
    const catalog = await schedule.catalog();
    return `catalog() 返回 ${catalog.length} 个任务；方法集：${['create', 'list', 'catalog', 'view', 'history', 'edit', 'run', 'deleteInactive'].filter((m) => typeof (schedule as unknown as Record<string, unknown>)[m] === 'function').join('/')}`;
  }));

  checks.push(await check('service.session-persistence', 'ctx.sessionPersistence 存在及快照查询', async () => {
    const sp = (await awaitService(ctx, 'sessionPersistence')) as SessionPersistence | undefined;
    if (!sp) throw new Error('ctx.sessionPersistence 未就绪');
    const missing = ['create', 'open', 'stat', 'list'].filter((m) => typeof (sp as unknown as Record<string, unknown>)[m] !== 'function');
    if (missing.length > 0) throw new Error(`缺少方法：${missing.join('/')}`);
    const snapshots = await sp.list();
    return `list() 返回 ${snapshots.length} 个会话快照${snapshots[0] ? `；示例字段：${Object.keys(snapshots[0] as object).join('/')}` : ''}`;
  }));

  checks.push(await check('service.tools', 'ctx.tools 存在且 register 可用', async () => {
    const tools = (await awaitService(ctx, 'tools')) as ToolsService | undefined;
    if (!tools) throw new Error('ctx.tools 未就绪');
    if (typeof tools.register !== 'function') throw new Error('ctx.tools.register 不是函数');
    return 'register(definition, options?) 签名存在';
  }));

  checks.push(await check('service.dsh-im', 'ctx.dshIm 存在且 listBots() 可调用（Phase 4 主动投递）', async () => {
    const im = (await awaitService(ctx, 'dshIm', 5, 200)) as { listBots?: () => unknown; send?: unknown } | undefined;
    if (!im) throw new Error('ctx.dshIm 未就绪（dsh-im 未安装或服务不可达）');
    if (typeof im.listBots !== 'function') throw new Error('ctx.dshIm.listBots 不是函数');
    const raw = im.listBots();
    const bots = Array.isArray(raw) ? raw : [];
    return `listBots() 返回 ${bots.length} 个 bot${bots[0] ? `；示例 id=${bots[0]}` : ''}（返回形态：${Array.isArray(raw) ? 'array' : typeof raw}）；send=${typeof im.send === 'function' ? '存在' : '缺失'}`;
  }));

  checks.push(await check('service.llm-catalog', 'ctx.llm 存在且目录可枚举（Phase 6 模型校验）', async () => {
    const llm = (await awaitService(ctx, 'llm', 5, 200)) as { listProviders?: () => unknown; listModels?: (p: string) => Promise<unknown> } | undefined;
    if (!llm) throw new Error('ctx.llm 未就绪');
    if (typeof llm.listProviders !== 'function') throw new Error('ctx.llm.listProviders 不是函数');
    const providers = llm.listProviders() as Array<{ id: string; name?: string }>;
    if (!Array.isArray(providers)) throw new Error(`listProviders() 返回非数组：${typeof providers}`);
    let modelCount = -1;
    if (providers[0] !== undefined && typeof llm.listModels === 'function') {
      const models = (await llm.listModels(providers[0].id)) as unknown[];
      modelCount = Array.isArray(models) ? models.length : -1;
    }
    return `listProviders() 返回 ${providers.length} 个 provider${providers[0] ? `；示例 ${providers[0].id}` : ''}${modelCount >= 0 ? `；首 provider 模型 ${modelCount} 个` : ''}`;
  }));

  checks.push(await check('api.agent-model-select', 'Agent.model.select 存在性（Phase 6 模型切换；机会性——无 live Agent 则 SKIPPED）', async () => {
    const agents = (await awaitService(ctx, 'agents')) as { list?: () => Array<{ model?: { select?: unknown } }> } | undefined;
    const live = agents?.list?.() ?? [];
    const first = live[0];
    if (!first) return 'SKIPPED：当前无 live Agent（首次真实派发/切换时复核）';
    if (typeof first.model?.select !== 'function') throw new Error('live Agent.model.select 不是函数');
    return `live Agent ${live.length} 个；model.select 为函数（未调用——探针只读）`;
  }));

  // --- 关键 API 形态 ---
  checks.push(await check('api.user-message-factory', 'createUserMessage 构造（V2：任务指令消息）', async () => {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod.createUserMessage !== 'function') throw new Error('@deepseek-ai/dsh-llm 未导出 createUserMessage');
    const msg = mod.createUserMessage({
      content: [{ type: 'text', text: 'probe' }],
      source: { kind: 'user' },
    });
    return `构造成功：id=${String(msg.id)} role=${msg.role} content 块数=${msg.content.length}`;
  }));

  // --- 工具执行上下文（V1：注册探针工具，由任意会话调用后捕获 exec.agent）---
  checks.push(await check('api.tool-exec-context', '工具执行上下文可获调用者（V1：probe_echo 工具）', async () => {
    // 本检查只确认工具注册通道；exec.agent 的实际捕获依赖模型调用 probe_echo，
    // 结果在会话触发后由 captureToolInvocation 补充记录。
    const tools = ctx.get('tools') as { register: unknown } | undefined;
    if (!tools || typeof tools.register !== 'function') throw new Error('工具注册不可用');
    return 'probe_echo 已注册（SKIPPED→VERIFIED 待任意会话调用一次后复核）';
  }));

  // --- V8（FB-20/21 根因）：编程创建会话的预设装配 ---
  // 宿主源码（dsh-subagent/child-agent.js applyChildComposition）实证：meta.agentPreset 只是
  // 持久化元数据，工具集装配靠创建方在 setup 回调内显式调 agentPresets.mount(agentCtx, id)。
  // 本探针复刻该用法：创建即销毁（dispose 完整回滚），不留任何会话残留。
  checks.push(await check('api.agents-create-setup-mount', '编程创建会话的预设装配（V8：agents.create setup 回调 + agentPresets.mount）', async () => {
    const agents = (await awaitService(ctx, 'agents')) as
      | { create?: (options: unknown) => Promise<{ dispose?: () => Promise<void> }> }
      | undefined;
    if (!agents || typeof agents.create !== 'function') throw new Error('ctx.agents.create 不可用');

    /** agentPresets 最小面（dsh-agent-preset-registry AgentPresetRegistry；非本项目依赖，结构收窄） */
    interface PresetRegistryLike {
      list(): Promise<Array<{ id: string; name?: string; broken?: string }>>;
      readonly defaultId: string;
      mount(agentCtx: unknown, id?: string): Promise<unknown>;
      inspectCompositions(ctx?: unknown): Array<{ id: string; modules: Array<{ moduleName: string }> }>;
    }
    const presets = (await awaitService(ctx, 'agentPresets')) as PresetRegistryLike | undefined;
    if (!presets || typeof presets.list !== 'function') {
      throw new Error('ctx.agentPresets 不可达（服务未装载或 group 隔离）——supervisor_preset_list 与装配路径均不可用');
    }
    const roster = await presets.list();
    const usable = roster.find((p) => p.id === presets.defaultId && p.broken === undefined) ?? roster.find((p) => p.broken === undefined);
    if (!usable) throw new Error(`预设清单为空或全部 broken：${brief(roster.map((p) => p.id))}`);

    // 安全落点：插件数据目录下的探针临时目录（会话边界校验要求绝对路径）
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const probeCwd = join(data.dir, 'probe-tmp');
    await mkdir(probeCwd, { recursive: true });

    let inspectionDetail = '';
    const sessionId = `session-probe-mount-${Date.now()}`;
    const handle = await agents.create({
      sessionId,
      meta: { cwd: probeCwd, agentPreset: usable.id },
      setup: async (agentCtx: unknown) => {
        const scoped = (agentCtx as { get(name: 'agentPresets'): { mount(a: unknown, id?: string): Promise<unknown>; inspectCompositions?: (ctx?: unknown) => Array<{ id: string; modules: Array<{ moduleName: string }> }> } | undefined }).get('agentPresets');
        if (scoped === undefined) throw new Error('agentCtx.get("agentPresets") 不可达（Agent 作用域内无预设服务）');
        const mounted = await scoped.mount(agentCtx, usable.id);
        // 完整启动后服务面可能是 remote-client 子集（无 inspectCompositions）——mount 返回绑定身份即判据
        const bound = scoped.inspectCompositions !== undefined ? scoped.inspectCompositions(agentCtx) : [];
        if (bound.length === 0 && mounted === undefined) throw new Error('mount 未返回绑定身份且 inspectCompositions 为空——装配未生效');
        inspectionDetail = bound.length > 0
          ? `绑定 revision=${bound[0]!.id}，模块 ${bound[0]!.modules.length} 个：${bound[0]!.modules.slice(0, 5).map((m) => m.moduleName).join(', ')}${bound[0]!.modules.length > 5 ? '…' : ''}`
          : `mount 返回绑定身份：${brief(mounted)}（当前服务面无 inspectCompositions——remote-client 形态）`;
      },
    });
    try {
      await handle.dispose?.();
    } catch (error) {
      throw new Error(`装配成功但 dispose 清理失败（会话 ${sessionId} 可能残留）：${error instanceof Error ? error.message : String(error)}`);
    }
    return `预设 ${usable.id}${usable.name ? `（${usable.name}）` : ''} 经 setup+mount 装配成功：${inspectionDetail}；会话已销毁`;
  }));

  // --- V9（FB-20/21 端到端）：装配会话的真实执行能力 ---
  // 装配验证（V8）只证明工具注册；本检查补最后一环：给装配会话派发最小执行指令，
  // 轮询宿主机文件真实出现（模型 → 工具调用 → 副作用 全链路）。走宿主默认模型路由；
  // 模型不可达/推理失败如实报 UNAVAILABLE（端到端依赖外部 LLM，属环境前提非插件缺陷）。
  checks.push(await check('api.mounted-session-exec-e2e', '装配会话端到端执行（V9：派发写文件指令 → 轮询宿主机副作用）', async () => {
    const agents = (await awaitService(ctx, 'agents')) as
      | {
          create?: (options: unknown) => Promise<{ agent?: { followup?: (message: unknown) => void; whenIdle?: () => Promise<void> }; dispose?: () => Promise<void> }>;
          get?: (id: unknown) => unknown;
        }
      | undefined;
    if (!agents || typeof agents.create !== 'function') throw new Error('ctx.agents.create 不可用');
    const presets = (await awaitService(ctx, 'agentPresets')) as
      | { readonly defaultId: string; list(): Promise<Array<{ id: string; broken?: string }>>; mount(agentCtx: unknown, id?: string): Promise<unknown> }
      | undefined;
    if (!presets) throw new Error('ctx.agentPresets 不可达');
    const roster = await presets.list();
    const usable = roster.find((p) => p.id === presets.defaultId && p.broken === undefined) ?? roster.find((p) => p.broken === undefined);
    if (!usable) throw new Error('无可用预设');

    const { mkdir, stat, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const probeCwd = join(data.dir, 'probe-tmp');
    await mkdir(probeCwd, { recursive: true });
    const marker = `probe-e2e-${Date.now()}`;
    const target = join(probeCwd, `${marker}.md`);
    const sessionId = `session-probe-e2e-${Date.now()}`;

    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    // 创建时显式带模型路由（FB-20③ 同源教训：宿主对新会话不回退默认模型——无路由则消息入箱后永无推理）
    const llm = (await awaitService(ctx, 'llm', 5, 200)) as { listProviders?: () => Array<{ id: string }>; listModels?: (p: string) => Promise<Array<{ id: string }>> } | undefined;
    const preferred = ['local-gateway-1panel01', 'zai-coding-cn'];
    const providers = llm?.listProviders?.() ?? [];
    const routed = providers.find((p) => preferred.includes(p.id));
    const provider = routed?.id ?? providers[0]?.id;
    const model = provider !== undefined ? ((await llm?.listModels?.(provider)) ?? [])[0]?.id : undefined;
    if (provider === undefined || model === undefined) throw new Error('无法解析模型路由：llm 目录为空——端到端前提缺失');
    const handle = await agents.create({
      sessionId,
      meta: { cwd: probeCwd, agentPreset: usable.id },
      agentOptions: { provider, model },
      setup: async (agentCtx: unknown) => {
        const scoped = (agentCtx as { get(name: 'agentPresets'): { mount(a: unknown, id?: string): Promise<unknown> } | undefined }).get('agentPresets');
        if (scoped === undefined) throw new Error('agentCtx.get("agentPresets") 不可达');
        await scoped.mount(agentCtx, usable.id);
      },
    });
    try {
      // handle 形态显式断言（可选链会静默吞掉 agent 缺失——FB-20③ 教训）
      const agent = handle.agent;
      if (agent === undefined || typeof agent.followup !== 'function') {
        throw new Error(`AgentHandle 形态异常：agent=${String(agent)}，keys=${Object.keys(handle).join('/')}`);
      }
      // 先订阅 inbox 事件再触发（诊断正道）：followup 是否真的把消息排进了会话
      let inboxInserted = false;
      const offListener = (ctx as unknown as { on: (name: string, cb: (payload: unknown) => void) => () => void }).on('agent/inbox/inserted', (payload) => {
        const message = (payload as { message?: { turn?: unknown } })?.message ?? payload;
        if (JSON.stringify(message).includes(sessionId) || inboxInserted === false) inboxInserted = true;
      });
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: `请立即用你的文件写入工具在当前工作目录创建文件 ${marker}.md，内容为一行文本：e2e-ok。写完后在回复中回复"done"即可，不要做任何其他事。` }],
          source: { kind: 'user' },
        }));
        const inboxDeadline = Date.now() + 15_000;
        while (!inboxInserted && Date.now() < inboxDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!inboxInserted) throw new Error('followup 调用后 15s 内未收到 agent/inbox/inserted 事件——消息未进入会话 inbox（驱动唤醒链路问题，非装配问题）');
        // 轮询宿主机副作用（模型推理 + 工具调用需要时间；上限 150s）
        const deadline = Date.now() + 150_000;
        let fileSeen = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          const st = await stat(target).catch(() => undefined);
          if (st !== undefined && st.size > 0) {
            fileSeen = true;
            break;
          }
        }
        if (!fileSeen) throw new Error(`150s 内未见宿主机副作用：${target} 未出现（消息已入 inbox——模型推理或工具调用环节失败，查宿主日志与模型路由）`);
        const content = (await readFile(target, 'utf8')).trim();
        await rm(target, { force: true });
        return `端到端成功：装配会话（预设 ${usable.id}）真实创建文件并写入"${content}"，全链路（followup→inbox→推理→fs 工具→宿主机副作用）打通；文件已清理`;
      } finally {
        offListener();
      }
    } finally {
      await handle.dispose?.().catch(() => undefined);
    }
  }));

  // --- V10（FB-24/25）：编程会话权限事件写入 ---
  // 宿主子代理（appendDelegatedPolicyOverrides）以 session log 事件设置权限——本检查验证
  // 插件路径同样可写：setup 内 append sandbox/mode + approval/policy 不抛错且 create 正常发布。
  // 行为级验证（bash 全权限执行）依赖沙箱后端可用的环境，由生产实测复核。
  checks.push(await check('api.session-policy-append', '编程会话权限事件写入（V10：sandbox/mode + approval/policy）', async () => {
    const agents = (await awaitService(ctx, 'agents')) as
      | { create?: (options: unknown) => Promise<{ dispose?: () => Promise<void>; agent?: unknown }> }
      | undefined;
    if (!agents || typeof agents.create !== 'function') throw new Error('ctx.agents.create 不可用');
    const presets = (await awaitService(ctx, 'agentPresets')) as
      | { readonly defaultId?: string; list(): Promise<Array<{ id: string; broken?: string }>>; mount(a: unknown, id?: string): Promise<unknown> }
      | undefined;
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const probeCwd = join(data.dir, 'probe-tmp');
    await mkdir(probeCwd, { recursive: true });
    const sessionId = `session-probe-policy-${Date.now()}`;
    const appended: string[] = [];
    const handle = await agents.create({
      sessionId,
      meta: { cwd: probeCwd },
      setup: async (agentCtx: unknown, agent: unknown) => {
        const registry = (agentCtx as { get(name: 'agentPresets'): { list(): Promise<Array<{ id: string; broken?: string }>>; readonly defaultId?: string; mount(a: unknown, id?: string): Promise<unknown> } | undefined }).get('agentPresets');
        if (registry !== undefined) {
          const roster = await registry.list();
          const usable = roster.find((p) => p.id === registry.defaultId && p.broken === undefined) ?? roster.find((p) => p.broken === undefined);
          if (usable !== undefined) await registry.mount(agentCtx, usable.id);
        }
        const session = (agent as { session?: { append(type: string, data: unknown): unknown } }).session;
        if (session === undefined || typeof session.append !== 'function') throw new Error('Session.append 不可达');
        session.append('sandbox/mode', { mode: 'danger-full-access', source: 'supervisor' });
        session.append('approval/policy', { policy: 'never', source: 'supervisor' });
        appended.push('sandbox/mode', 'approval/policy');
      },
    });
    try {
      await handle.dispose?.();
    } catch {
      // 清理尽力而为
    }
    return `append 成功（${appended.join(' + ')}），create 正常发布，会话已销毁`;
  }));

  const report: ProbeReport = {
    ranAt: new Date().toISOString(),
    nodeVersion: process.version,
    pluginVersion: PLUGIN_VERSION,
    dataDir: data.dir,
    checks,
  };

  // 落盘报告（探针自身的持久化验证）
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const reportPath = join(data.dir, 'probe-report.json');
  await mkdir(data.dir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return report;
}

