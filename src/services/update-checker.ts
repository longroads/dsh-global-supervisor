/**
 * 更新检查服务：从 npm registry 探测最新版（主源 npmjs 失败走 npmmirror 镜像）。
 * 只读网络查询，无副作用；结果 TTL 缓存，设置面板经 GET settings 消费。
 */
import { PLUGIN_VERSION } from '../version.js';

/** 面板消费的更新状态形态。 */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  source: 'npm' | 'npmmirror' | null;
  error: string | null;
  /** 配置 updateCheck=false 时置真：不发起网络请求 */
  disabled: boolean;
}

interface UpdateCheckerOptions {
  packageName?: string;
  registries?: string[];
  ttlMs?: number;
  timeoutMs?: number;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
}

const DEFAULT_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

/** 数字分段版本比较：a<b → -1，相等 → 0，a>b → 1（非数字段按 0 处理）。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((seg) => {
    const n = Number.parseInt(seg, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export class UpdateChecker {
  private readonly opts: UpdateCheckerOptions;
  private state: UpdateInfo;
  private inflight: Promise<UpdateInfo> | null = null;

  constructor(opts: UpdateCheckerOptions = {}) {
    this.opts = opts;
    this.state = {
      current: PLUGIN_VERSION,
      latest: null,
      updateAvailable: false,
      checkedAt: null,
      source: null,
      error: null,
      disabled: opts.enabled === false,
    };
  }

  getState(): UpdateInfo {
    return { ...this.state };
  }

  /** 缓存过期则后台刷新（不阻塞调用方）；GET settings 每页打开触发一次。 */
  refreshIfStale(): void {
    if (this.state.disabled) return;
    const ttl = this.opts.ttlMs ?? 6 * 60 * 60_000;
    if (this.state.checkedAt !== null && Date.now() - Date.parse(this.state.checkedAt) < ttl) return;
    void this.refresh().catch(() => undefined);
  }

  /** 刷新最新版探测（总是真网络请求，TTL 逻辑只在 refreshIfStale）；并发去重；主源失败自动走镜像源。 */
  async refresh(): Promise<UpdateInfo> {
    if (this.state.disabled) return this.getState();
    if (this.inflight !== null) return this.inflight;
    const pkg = this.opts.packageName ?? 'dsh-global-supervisor';
    const registries = this.opts.registries ?? DEFAULT_REGISTRIES;
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    this.inflight = (async () => {
      let lastError = 'registry-unreachable';
      for (const base of registries) {
        try {
          const resp = await fetchImpl(`${base}/${pkg}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
          if (!resp.ok) {
            lastError = `http-${String(resp.status)}`;
            continue;
          }
          const doc = (await resp.json()) as { version?: unknown };
          if (typeof doc.version === 'string' && doc.version !== '') {
            this.state = {
              current: PLUGIN_VERSION,
              latest: doc.version,
              updateAvailable: compareVersions(PLUGIN_VERSION, doc.version) < 0,
              checkedAt: new Date().toISOString(),
              source: base.includes('npmmirror') ? 'npmmirror' : 'npm',
              error: null,
              disabled: false,
            };
            return this.getState();
          }
          lastError = 'no-version-field';
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      this.state = { ...this.getState(), checkedAt: new Date().toISOString(), error: lastError };
      return this.getState();
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}
