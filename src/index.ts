/**
 * dsh-global-supervisor 插件入口。
 *
 * 两种运行形态（可并存）：
 * - probe 模式：启动自检，报告写入数据目录（开发期诊断）；
 * - 业务模式：routerSessionId 配置非空时组装服务栈并注册 15 个工具。
 * 沙箱纪律：顶层零 node:* 静态依赖；服务访问一律 ctx.get（docs/API_COMPATIBILITY.md）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';

/** 最近的 probe_echo 调用捕获（V1 复核证据；纯内存态）。 */
let lastToolInvocation: { agentId: string; args: unknown; at: string } | undefined;

/** 记录一次 probe_echo 调用（由工具 execute 回调写入）。 */
function captureToolInvocation(agentId: string | undefined, args: unknown): void {
  lastToolInvocation = { agentId: agentId ?? '(exec.agent 缺失)', args, at: new Date().toISOString() };
}

/** 事件接入配置（Webhook 事件路由，ITERATION_PLAN 1-D）。 */
interface EventsConfig {
  webhookSources: string[];
  maxEventTextChars: number;
  redactPatterns: boolean;
}

/** 通知路由配置（Phase 4：IM 优先、失败降级 Router 会话）。 */
interface NotifierOptions {
  type: 'session' | 'dsh-im';
  botId: string;
  targetId: string;
}

/** 插件配置（结构定义；schema 声明见下方 Config，profile 的 cordis.patch.yml 可覆盖）。 */
interface PluginConfig {
  probe: boolean;
  dataDir: string;
  routerWorkspaceId: string;
  routerSessionId: string;
  events: EventsConfig;
  notifier: NotifierOptions;
}

/** 插件配置 schema（schemastery，DSH 插件惯例）。 */
export const Config = z.object({
  probe: z.boolean().default(false).description('开发期 API 探针：启动时运行兼容性自检，报告写入数据目录'),
  dataDir: z.string().default('').description('插件数据目录（默认经 dsh-home-paths 解析为 ~/.dsh/global-supervisor）'),
  routerWorkspaceId: z.string().default('').description('Router 所属 DSH workspace ID（super-space01）'),
  routerSessionId: z.string().default('').description('Router 固定会话 ID（supervisor_* 工具的唯一授权调用方；留空则不启用业务工具）'),
  events: z.object({
    webhookSources: z.array(z.string()).default([]).description('允许的 Webhook 事件来源标识白名单；空数组表示不限制'),
    maxEventTextChars: z.number().default(4000).description('Webhook 事件正文截断上限（字符）'),
    redactPatterns: z.boolean().default(true).description('是否启用事件正文凭证脱敏（ghp_/PEM/Bearer/api key）'),
  }).default({ webhookSources: [], maxEventTextChars: 4000, redactPatterns: true }).description('事件接入配置'),
  notifier: z.object({
    type: z.string().default('session').description('通知通道：session（仅 Router 会话）| dsh-im（优先 IM，失败降级会话）'),
    botId: z.string().default('').description('dsh-im 机器人 ID（dsh-im 设置页「复制调用参数」）'),
    targetId: z.string().default('supervisor-alerts').description('dsh-im 投递目标 ID（需已在 dsh-im 中保存）'),
  }).default({ type: 'session', botId: '', targetId: 'supervisor-alerts' }).description('通知路由配置'),
});

/** Cordis 插件名（profile bundles / patch 的定位标识）。 */
export const name = 'global-supervisor';

/** probe_echo：探针工具（仅开发期），用于捕获工具执行上下文中的调用者身份（V1 复核）。 */
const probeEchoTool: ToolDefinition = {
  name: 'probe_echo',
  description: '开发期探针工具：原样返回输入并记录调用者身份。无业务副作用。',
  parameters: { type: 'object', properties: { echo: { type: 'string', description: '任意回显文本' } } },
  output: {
    schema: { type: 'object', properties: { echoed: { type: 'string' }, byAgent: { type: 'string' } } },
    render: (_args, value) => {
      const record = value as { echoed?: string; byAgent?: string };
      return [{ type: 'text', text: `echoed=${record['echoed'] ?? ''} byAgent=${record['byAgent'] ?? ''}` }];
    },
  },
  async execute(args, exec) {
    const input = args as { echo?: string };
    captureToolInvocation(exec.agent?.id, args);
    return { echoed: input['echo'] ?? '', byAgent: exec.agent?.id ?? '(missing)' };
  },
};

/**
 * 启动标记：把插件启动痕迹直接写入文件系统（绕过可能不可见的 ctx.logger），
 * 用于区分"插件未进加载树"与"加载后内部失败"两类问题。
 */
async function writeLoadMarker(stage: string, detail: unknown): Promise<void> {
  try {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), '.dsh', 'global-supervisor-load.log');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${new Date().toISOString()} [${stage}] ${JSON.stringify(detail)}\n`, 'utf8');
  } catch {
    // 文件系统不可用时无通道可写——保持静默，由探针报告缺失间接暴露
  }
}

/**
 * 插件应用入口。
 * @param ctx - Cordis 上下文（宿主为 DSH Desktop 0.2.2-rc.x Host 进程）
 * @param config - 已验证配置
 */
export function apply(ctx: Context, config: PluginConfig): void {
  void writeLoadMarker('apply-enter', { probe: config.probe, dataDir: config.dataDir });
  ctx.logger.info(`dsh-global-supervisor 加载（probe=${String(config.probe)}）`);

  // 探针工具注册：开发期验证工具执行上下文（V1）；经 ctx.get 绕开沙箱属性门禁
  if (config.probe) {
    try {
      const tools = ctx.get('tools') as { register: (tool: typeof probeEchoTool) => unknown } | undefined;
      tools?.register(probeEchoTool);
      void writeLoadMarker('probe-echo-registered', {});
    } catch (error) {
      void writeLoadMarker('probe-echo-failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // 启动探针（probe 模式；动态加载 probe 模块，保持本模块顶层零 node:* 依赖）
  if (config.probe) {
    void (async () => {
      try {
        const { runProbe } = await import('./probe.js');
        const report = await runProbe(ctx, config.dataDir);
        const verified = report.checks.filter((c) => c.status === 'VERIFIED').length;
        const failed = report.checks.filter((c) => c.status !== 'VERIFIED');
        void writeLoadMarker('probe-done', { verified, total: report.checks.length, dataDir: report.dataDir });
        ctx.logger.info(`API 探针完成：${verified}/${report.checks.length} 项 VERIFIED，报告已写入 ${report.dataDir}`);
        for (const item of failed) {
          ctx.logger.warn(`  [${item.status}] ${item.id}：${item.detail}`);
        }
      } catch (error) {
        void writeLoadMarker('probe-crashed', { message: error instanceof Error ? error.stack ?? error.message : String(error) });
        ctx.logger.error(`API 探针运行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    })();
  } else {
    void writeLoadMarker('probe-disabled', { note: 'config.probe=false——若期望探针运行，请检查 patch 配置' });
  }

  // 业务模式：Router 身份可经 patch 预置或运行时认领（supervisor_claim_router），
  // 均非必需——无预置时栈照常启动，等待任意会话首次认领
  {
    void (async () => {
      try {
        const { awaitService } = await import('./adapters/host-services.js');
        const tools = await awaitService<{ register: (tool: ToolDefinition) => unknown }>(ctx, 'tools');
        const { createStack } = await import('./runtime.js');
        const stack = await createStack(ctx, { dataDir: config.dataDir, routerSessionId: config.routerSessionId, notifier: config.notifier });
        // Host 重启存疑恢复（需求说明第八节）：超时窗口已过判 failed/timeout，未过保持 running 待 Worker 汇报
        const recovery = stack.taskManager.recoverFromRestart();
        if (recovery.expiredIds.length > 0 || recovery.pendingIds.length > 0) {
          void writeLoadMarker('restart-recovery', recovery);
          ctx.logger.info(`重启恢复：${recovery.pendingIds.length} 个任务存疑待汇报，${recovery.expiredIds.length} 个已判超时`);
        }
        stack.monitor.start();
        // Schedule 对账（第八节：Host 任务与本地绑定双向核对；远端消失的绑定停用）
        const scheduleReconcile = await stack.scheduler.reconcile();
        if (scheduleReconcile.remoteMissing.length > 0) {
          void writeLoadMarker('schedule-reconcile', scheduleReconcile);
        }
        // 事件源接入（§6.4 + ITERATION_PLAN 1-C；事件名经 0.2.2-rc.1 类型基线核实）：
        // agent/error / agent/status / agent/inbox/inserted（dsh-agent）、
        // tools/result（dsh-tools）、session/event 过滤 turn/end（dsh-session）
        ctx.on('agent/error', (payload: { agent: { id: string }; error: unknown }) => {
          void stack.eventManager.ingest({
            eventId: `agent-error:${payload.agent.id}:${Date.now()}`,
            source: 'agent',
            type: 'agent.error',
            workspaceId: undefined,
            payloadJson: JSON.stringify({ message: payload.error instanceof Error ? payload.error.message : String(payload.error) }),
          });
        });
        ctx.on('agent/status', (payload: { agent?: { id: string }; status?: string }) => {
          if (!payload.agent?.id || !payload.status) return;
          void stack.eventManager.ingest({
            eventId: `agent-status:${payload.agent.id}:${payload.status}:${Date.now()}`,
            source: 'agent',
            type: 'agent.status',
            payloadJson: JSON.stringify({ agentId: payload.agent.id, status: payload.status }),
          });
        });
        ctx.on('agent/inbox/inserted', (payload) => {
          void stack.eventManager.ingest({
            eventId: `user-msg:${payload.agent.id}:${payload.message.id}`,
            source: 'agent',
            type: 'user.message',
            payloadJson: JSON.stringify({ agentId: payload.agent.id, content: payload.message.content }),
            human: payload.message.source?.kind === 'user',
          });
        });
        ctx.on('tools/result', (exec): undefined => {
          const agentId = exec.agent?.id;
          if (agentId) {
            void stack.eventManager.ingest({
              eventId: `tool-result:${agentId}:${exec.name}:${Date.now()}`,
              source: 'agent',
              type: 'tool.result',
              payloadJson: JSON.stringify({ toolName: exec.name, agentId }),
            });
          }
          return undefined;
        });
        ctx.on('session/event', (session, event) => {
          if (event.type !== 'turn/end') return;
          void stack.eventManager.ingest({
            eventId: `turn-end:${session.id}:${String(event.seq)}`,
            source: 'agent',
            type: 'turn.end',
            payloadJson: JSON.stringify({ sessionId: session.id, turn: event.data.turn, reason: event.data.reason }),
          });
        });
        // EventManager 派发规则：Worker turn 结束 → 刷新对应 running 任务心跳（Watchdog 数据源）
        stack.eventManager.on('turn.end', async (event) => {
          const payload = JSON.parse(event.payload_json) as { sessionId?: string };
          if (!payload.sessionId) return;
          for (const task of stack.taskManager.tasks.list({ status: 'running' })) {
            if (task.assigned_session_id === payload.sessionId) stack.taskManager.tasks.touchReport(task.id);
          }
        });
        // Phase 2 事件路由决策层（'*' 全量通配；route 内部永不抛错，派发失败降级 pending 记审计）
        stack.eventManager.on('*', (event) => {
          void stack.eventRouter.route(event);
        });
        // 设置面板 HTTP API（Router 身份管理入口；契约见 docs/UI_PANEL_PLAN.md）
        const { registerSettingsApi } = await import('./services/settings-api.js');
        await registerSettingsApi(ctx, stack, config.events);
        const { buildSupervisorTools } = await import('./tools/supervisor-tools.js');
        const { buildWorkerReportTool } = await import('./tools/worker-report-tool.js');
        const all = [...buildSupervisorTools(stack), buildWorkerReportTool(stack)];
        for (const tool of all) {
          tools.register(tool);
        }
        void writeLoadMarker('stack-ready', { tools: all.length, dataDir: stack.dataDir, router: config.routerSessionId });
        ctx.logger.info(`dsh-global-supervisor 服务栈就绪：${all.length} 个工具已注册`);
      } catch (error) {
        void writeLoadMarker('stack-failed', { message: error instanceof Error ? error.stack ?? error.message : String(error) });
        ctx.logger.error(`服务栈初始化失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    })();
  }
}
