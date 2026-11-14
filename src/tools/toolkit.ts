/**
 * 工具构建工具集：统一 ToolDefinition 构造 + 执行期身份校验（权限第二防线）。
 * 沙箱限制说明：façade 的 tools.register 仅接受单参数，注册期 when 防线不可用——
 * 权限架构为「全局注册 + 执行期 exec.agent.id 强校验 + 业务层归属校验」三段式。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/** 执行期调用者身份（透传给业务 handler）。 */
export interface ToolCallContext {
  callerSessionId: string;
}

/** 业务处理器（身份已校验通过）。 */
export type ToolHandler = (args: unknown, ctx: ToolCallContext) => Promise<unknown> | unknown;

/** 执行期权限守卫（第二防线；false 时返回结构化拒绝值。workspace 级判定需异步，支持 Promise）。 */
export type AccessGuard = (callerSessionId: string) => boolean | Promise<boolean>;

/** 拒绝返回的稳定结构（模型可读、程序可判别）。 */
export interface GuardDenied {
  error: 'forbidden';
  message: string;
}

export function isGuardDenied(value: unknown): value is GuardDenied {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['error'] === 'forbidden';
}

/** 构造带身份校验的工具定义。 */
export function makeTool(input: {
  name: string;
  description: string;
  parameters: ToolDefinition['parameters'];
  resultSchema: ToolDefinition['output']['schema'];
  guard: AccessGuard;
  guardDeniedMessage: string;
  handler: ToolHandler;
  /** 协作式超时预算（毫秒）：声明即承诺工具会把 exec.signal 转发给实现。 */
  timeoutMs?: number;
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: {
      schema: input.resultSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    async execute(args, exec) {
      const caller = exec.agent?.id;
      if (!caller || !(await input.guard(caller))) {
        return { error: 'forbidden', message: input.guardDeniedMessage } satisfies GuardDenied;
      }
      return input.handler(args, { callerSessionId: caller });
    },
  };
}

/** 解析工具参数对象（未知负载安全收窄）。 */
export function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** 取字符串参数（缺省回退）。 */
export function stringArg(record: Record<string, unknown>, key: string, fallback?: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : (fallback ?? '');
}

/** 取可选字符串参数。 */
export function optionalStringArg(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 取整数参数（越界或缺省回退）。 */
export function intArg(record: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
