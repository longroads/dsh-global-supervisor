/**
 * Adapter 共享：宿主服务等待式解析（沙箱契约，见 docs/API_COMPATIBILITY.md）。
 * 服务链异步初始化（如 schedule 依赖 sessionPersistence），apply 时刻可能未就绪；
 * 统一在此轮询 ctx.get，业务层拿到的永远是已就绪服务或明确的超时错误。
 */
import type { Context } from '@deepseek-ai/cordis';

/** 服务等待超时错误（机器可判别）。 */
export class ServiceUnavailableError extends Error {
  readonly serviceName: string;
  constructor(serviceName: string, waitedMs: number) {
    super(`宿主服务 ${serviceName} 在 ${waitedMs}ms 内未就绪`);
    this.name = 'ServiceUnavailableError';
    this.serviceName = serviceName;
  }
}

/** 默认等待参数：50 次 × 200ms = 10 秒（覆盖 Host 冷启动的服务链初始化）。 */
const DEFAULT_RETRIES = 50;
const DEFAULT_INTERVAL_MS = 200;

/** 等待服务就绪并返回（沙箱门禁下唯一合法的服务获取通道）。 */
export async function awaitService<T>(ctx: Context, name: string, retries = DEFAULT_RETRIES, intervalMs = DEFAULT_INTERVAL_MS): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      const service = ctx.get(name);
      if (service !== undefined && service !== null) return service as T;
    } catch {
      // apply 早期门禁可能抛错——同样进入等待重试
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new ServiceUnavailableError(name, retries * intervalMs);
}
