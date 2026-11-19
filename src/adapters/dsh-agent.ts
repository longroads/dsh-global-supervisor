/**
 * AgentRegistry 适配器：Worker 会话控制的唯一触达点。
 * 派发编排：get-or-resume（活跃复用/冷恢复）→ createUserMessage → followup。
 * 铁律：不持久化 Agent 句柄——每次派发即时解析（Host 重启安全）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentCancelCause, AgentRegistry, CreateAgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { awaitService } from './host-services.js';

/** Agent 活动状态纯数据视图。 */
export interface AgentInfo {
  sessionId: string;
  status: 'idle' | 'running';
  provider: string | undefined;
  model: string | undefined;
}

/** 模型偏好入参（plain 形状；reasoningEffort 经品牌化构造在适配层转换）。 */
export interface ModelPrefInput {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 转为 ModelSelection（effort 经 ReasoningEffortId 构造函数品牌化——合规转换非断言）。 */
async function toSelection(pref: ModelPrefInput): Promise<ModelSelection> {
  if (pref.reasoningEffort === undefined || pref.reasoningEffort === '') return { provider: pref.provider, model: pref.model };
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm');
  return { provider: pref.provider, model: pref.model, reasoningEffort: ReasoningEffortId(pref.reasoningEffort) };
}

export class DshAgentAdapter {
  constructor(private readonly ctx: Context) {}

  private agents(): Promise<AgentRegistry> {
    return awaitService<AgentRegistry>(this.ctx, 'agents');
  }

  /** 当前活动 Agent 列表（运行时 Registry，非持久化清单）。 */
  async listAgents(): Promise<AgentInfo[]> {
    const agents = await this.agents();
    return agents.list().map((agent) => ({
      sessionId: agent.id,
      status: agent.status,
      provider: agent.options.provider,
      model: agent.options.model,
    }));
  }

  /** 查活动 Agent（不存在返回 undefined——冷会话）。 */
  async getAgent(sessionId: string): Promise<Agent | undefined> {
    const agents = await this.agents();
    return agents.get(sessionId as SessionId);
  }

  /** 会话是否正在执行（无活动 Agent 视为空闲）。 */
  async isBusy(sessionId: string): Promise<boolean> {
    const agent = await this.getAgent(sessionId);
    return agent !== undefined && agent.status === 'running';
  }

  /** get-or-resume：活跃复用；冷会话经 sessionPersistence 恢复。 */
  async ensureAgent(sessionId: string): Promise<Agent> {
    const agents = await this.agents();
    const live = agents.get(sessionId as SessionId);
    if (live) return live;
    const handle = await agents.resume({ resumeSessionId: sessionId as SessionId });
    return handle.agent;
  }

  /**
   * 创建全新 Worker 会话（FB-10①：会话供给，agents.create 为探针 VERIFIED 能力）。
   * 身份由调用方生成（session-<uuid>）；cwd 必须是受管 workspace 的绝对路径（会话边界校验）。
   * 不持久化 AgentHandle——后续派发走既有 get-or-resume 链路（Host 重启安全）。
   *
   * FB-20/21 根因修复（V8/V9 探针 VERIFIED 配方，四要素缺一不可）：
   * ① meta.cwd 会话落点；② meta.agentPreset 持久化元数据（记录用）；③ agentOptions 初始模型路由
   * （宿主对新会话不回退默认模型）；④ setup 回调内 agentCtx.get('agentPresets').mount(agentCtx, id)
   * ——预设装配的唯一真实入口（宿主 dsh-subagent/applyChildComposition 同款用法；meta.agentPreset
   * 本身不触发装配）。preset 未提供时不挂 setup（无装配裸会话，仅兼容显式放行场景）。
   *
   * FB-24/25 执行环境修复：setup 内向 Session append 权限事件（宿主 appendDelegatedPolicyOverrides
   * 同款机制——session log 是权限状态的权威源）：sandbox/mode（默认 danger-full-access，绕开
   * "后端不可用即失败"的沙箱链）+ approval/policy=never（审批永不挂起——触碰权限边界直接拒绝，
   * Worker 如实 blocked 汇报而非死等，杜绝任务级会话"无人接收审批"死锁）。
   * create 返回与 registry 登记之间存在时序窗口（FB-17/18），故 create 后有界轮询直至可见。
   */
  async createSession(
    sessionId: string,
    cwd: string,
    opts?: { readyTimeoutMs?: number; agentPreset?: string; provider?: string; model?: string; sandboxMode?: 'danger-full-access' | 'workspace-write' | 'read-only' },
  ): Promise<boolean> {
    const agents = await this.agents();
    const route = opts?.provider !== undefined && opts?.model !== undefined ? { provider: opts.provider, model: opts.model } : undefined;
    const presetId = opts?.agentPreset;
    const sandboxMode = opts?.sandboxMode ?? 'danger-full-access';
    const createOptions: CreateAgentOptions = {
      sessionId: sessionId as SessionId,
      meta: { cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
      ...(route !== undefined ? { agentOptions: route } : {}),
      setup: (agentCtx: Context, agent: Agent) => this.setupWorkerSession(agentCtx, agent, presetId, sandboxMode),
    };
    await agents.create(createOptions);
    const deadline = Date.now() + (opts?.readyTimeoutMs ?? 10_000);
    for (;;) {
      if (agents.get(sessionId as SessionId) !== undefined) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * 编程创建会话的初始化（setup 时机：Session 已建可写、Agent 未注册——首回合前生效）：
   * ① 预设装配（有 preset 时）；② 权限事件 append（恒定）。
   */
  private async setupWorkerSession(agentCtx: Context, agent: Agent, presetId: string | undefined, sandboxMode: string): Promise<void> {
    if (presetId !== undefined) {
      await this.mountPreset(agentCtx, presetId);
    }
    const session = (agent as unknown as {
      session?: { append(type: string, data: unknown): unknown };
    }).session;
    if (session === undefined || typeof session.append !== 'function') {
      throw new Error('SESSION_UNAVAILABLE: Agent 未暴露 Session——权限事件无法写入（宿主版本差异）');
    }
    try {
      session.append('sandbox/mode', { mode: sandboxMode, source: 'supervisor' });
      session.append('approval/policy', { policy: 'never', source: 'supervisor' });
    } catch (error) {
      throw new Error(`权限事件写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Agent 作用域内的预设装配（FB-21 根因）：mount 只在 agentCtx 的服务面上可用
   * （插件 Host ctx 拿到的是 remote-client 子集——无 mount，实测双面服务）。
   * mount 失败即抛错（setup throw 会回滚会话创建，无残留）。
   */
  private async mountPreset(agentCtx: Context, presetId: string): Promise<void> {
    const presets = (agentCtx as unknown as {
      get(name: 'agentPresets'): { mount(ctx: unknown, id?: string): Promise<unknown> } | undefined;
    }).get('agentPresets');
    if (presets === undefined) {
      throw new Error('PRESET_UNAVAILABLE: Agent 作用域内无 agentPresets 服务（宿主未装载预设注册表）');
    }
    try {
      await presets.mount(agentCtx, presetId);
    } catch (error) {
      throw new Error(`预设 ${presetId} 装配失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 派发任务指令：ensureAgent → followup（排队一个完整执行轮次）。
   * modelPref 非空时在 followup 前应用模型选择（任务边界切换，KV-cache 代价最小；
   * select 等值幂等、持久化进会话日志——见 dsh-agent model-selection）。
   * source 用 { kind: 'user' }（探针已验证的构造形态；supervisor 代表用户派发）。
   */
  async dispatch(sessionId: string, text: string, modelPref?: ModelPrefInput): Promise<void> {
    const agent = await this.ensureAgent(sessionId);
    if (modelPref !== undefined) {
      agent.model.select(await toSelection(modelPref));
    }
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    );
  }

  /** 对 live 会话立即应用模型选择（冷会话返回 false，不主动唤醒——由下次派发承担）。 */
  async selectModelNow(sessionId: string, pref: ModelPrefInput): Promise<boolean> {
    const agent = await this.getAgent(sessionId);
    if (!agent) return false;
    agent.model.select(await toSelection(pref));
    return true;
  }

  /** 运行中纠偏（不排队新轮次）。 */
  async steer(sessionId: string, text: string): Promise<void> {
    const agent = await this.ensureAgent(sessionId);
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    );
  }

  /** 取消当前执行（保留排队任务由调用方决定 keepInbox）。 */
  async cancelAgent(sessionId: string, cause: string, keepInbox = false): Promise<void> {
    const agent = await this.getAgent(sessionId);
    if (agent) {
      agent.cancel(cause as unknown as AgentCancelCause, { keepInbox });
    }
  }

  /** 等待会话整体空闲（含 followup 排队内容的收敛）。 */
  async whenIdle(sessionId: string): Promise<void> {
    const agent = await this.ensureAgent(sessionId);
    await agent.whenIdle();
  }
}
