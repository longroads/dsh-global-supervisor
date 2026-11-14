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
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';

/** 最近的 probe_echo 调用捕获（V1 复核证据；纯内存态）。 */
let lastToolInvocation: { agentId: string; args: unknown; at: string } | undefined;

/** 记录一次 probe_echo 调用（由工具 execute 回调写入）。 */
function captureToolInvocation(agentId: string | undefined, args: unknown): void {
  lastToolInvocation = { agentId: agentId ?? '(exec.agent 缺失)', args, at: new Date().toISOString() };
}

/** 插件配置（结构定义；schema 声明见下方 Config，profile 的 cordis.patch.yml 可覆盖）。 */
interface PluginConfig {
  probe: boolean;
  dataDir: string;
  routerWorkspaceId: string;
  routerSessionId: string;
}

/** 插件配置 schema（schemastery，DSH 插件惯例）。 */
export const Config = z.object({
  probe: z.boolean().default(false).description('开发期 API 探针：启动时运行兼容性自检，报告写入数据目录'),
  dataDir: z.string().default('').description('插件数据目录（默认经 dsh-home-paths 解析为 ~/.dsh/global-supervisor）'),
  routerWorkspaceId: z.string().default('').description('Router 所属 DSH workspace ID（super-space01）'),
  routerSessionId: z.string().default('').description('Router 固定会话 ID（supervisor_* 工具的唯一授权调用方；留空则不启用业务工具）'),
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

  // 业务模式：Router 会话配置就绪时组装服务栈并注册 16 个工具（方案 §7 的 15 个 + adopt 纳管既有 workspace）
  if (config.routerSessionId.trim() !== '') {
    void (async () => {
      try {
        const { awaitService } = await import('./adapters/host-services.js');
        const tools = await awaitService<{ register: (tool: ToolDefinition) => unknown }>(ctx, 'tools');
        const { createStack } = await import('./runtime.js');
        const stack = await createStack(ctx, { dataDir: config.dataDir, routerSessionId: config.routerSessionId });
        // Host 重启存疑恢复（需求说明第八节）：超时窗口已过判 failed/timeout，未过保持 running 待 Worker 汇报
        const recovery = stack.taskManager.recoverFromRestart();
        if (recovery.expiredIds.length > 0 || recovery.pendingIds.length > 0) {
          void writeLoadMarker('restart-recovery', recovery);
          ctx.logger.info(`重启恢复：${recovery.pendingIds.length} 个任务存疑待汇报，${recovery.expiredIds.length} 个已判超时`);
        }
        stack.monitor.start();
        const { buildSupervisorTools } = await import('./tools/supervisor-tools.js');
        const { buildWorkerReportTool } = await import('./tools/worker-report-tool.js');
        const all = [...buildSupervisorTools(stack, config.routerSessionId), buildWorkerReportTool(stack)];
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
