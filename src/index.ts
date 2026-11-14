/**
 * dsh-global-supervisor 插件入口。
 *
 * 当前阶段：S1 API 探针 + S2 工程骨架。
 * 刻意不声明 Cordis inject 服务清单：探针阶段以运行时探测代替静态声明，
 * 服务缺失会在 probe 报告中以 UNAVAILABLE 显式呈现（而非加载失败）。
 * 业务实现阶段（S3+）将按 VERIFIED 结论补齐 inject。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-tools';
import { captureToolInvocation, runProbe } from './probe.js';

/** 插件配置（结构定义；schema 声明见下方 Config，profile 的 cordis.patch.yml 可覆盖）。 */
interface PluginConfig {
  probe: boolean;
  dataDir: string;
}

/** 插件配置 schema（schemastery，DSH 插件惯例）。 */
export const Config = z.object({
  probe: z.boolean().default(false).description('开发期 API 探针：启动时运行兼容性自检，报告写入数据目录'),
  dataDir: z.string().default('').description('插件数据目录（默认经 dsh-home-paths 解析为 ~/.dsh/global-supervisor）'),
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
 * 插件应用入口。
 * @param ctx - Cordis 上下文（宿主为 DSH Desktop 0.2.2-rc.x Host 进程）
 * @param config - 已验证配置
 */
export function apply(ctx: Context, config: PluginConfig): void {
  ctx.logger.info(`dsh-global-supervisor 加载（probe=${String(config.probe)}）`);

  // 探针工具注册：开发期验证工具执行上下文（V1）
  if (config.probe) {
    ctx.tools?.register(probeEchoTool);
  }

  // 启动探针（probe 模式）
  if (config.probe) {
    void (async () => {
      try {
        const report = await runProbe(ctx, config.dataDir);
        const verified = report.checks.filter((c) => c.status === 'VERIFIED').length;
        const failed = report.checks.filter((c) => c.status !== 'VERIFIED');
        ctx.logger.info(`API 探针完成：${verified}/${report.checks.length} 项 VERIFIED，报告已写入 ${report.dataDir}`);
        for (const item of failed) {
          ctx.logger.warn(`  [${item.status}] ${item.id}：${item.detail}`);
        }
      } catch (error) {
        ctx.logger.error(`API 探针运行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    })();
  }
}
