/**
 * AgentRegistry 适配器：Worker 会话控制的唯一触达点。
 * 派发编排：get-or-resume（活跃复用/冷恢复）→ createUserMessage → followup。
 * 铁律：不持久化 Agent 句柄——每次派发即时解析（Host 重启安全）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentCancelCause, AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
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
