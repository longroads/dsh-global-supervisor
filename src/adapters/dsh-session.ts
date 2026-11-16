/**
 * SessionPersistence 适配器：持久化会话快照查询的唯一触达点
 * （Workspace 归属核对与冷恢复前的存在性检查）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { awaitService } from './host-services.js';

/** 宿主折叠后的会话标题快照条目。 */
type TitleSnapshot = { sessionId: SessionId; status: string; title?: { title: string; source: string } };

/**
 * 会话查询服务面（readTitleSnapshots = DSH 侧边栏会话名的同源读取）。
 * 声明为可选：本宿主运行时该服务可能不提供此方法（实测 TypeError），
 * 必须经能力探测确认后再调用，禁止盲目调用未 VERIFIED 接口。
 */
interface SessionQueryLike {
  readTitleSnapshots?(sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<TitleSnapshot[]>;
}

/**
 * sessionQuery 标题能力探测结论（进程内只探一次并缓存）。
 * 可用时缓存已绑定 this 的读取函数，调用点因此无需任何断言。
 */
type TitleCapability =
  | { readonly available: true; readonly readTitleSnapshots: (sessionIds: readonly SessionId[], signal?: AbortSignal) => Promise<TitleSnapshot[]> }
  | { readonly available: false; readonly reason: string };

/** 会话快照纯数据视图。 */
export interface SessionSnapshot {
  sessionId: string;
  cwd: string | undefined;
  createdAt: number | undefined;
  revision: unknown;
  sizeBytes: number | undefined;
}

export class DshSessionAdapter {
  /** 标题能力探测的进程内缓存（undefined = 尚未探测；并发调用共享同一次探测）。 */
  private titleCapability: Promise<TitleCapability> | undefined;

  constructor(
    private readonly ctx: Context,
    /** projcache 目录注入（测试用；缺省 ~/.dsh/storages/session_projcache/sessions） */
    private readonly projcacheDir?: string,
    /** 诊断行注入（测试用；缺省追加 ~/.dsh/global-supervisor-load.log） */
    private readonly titleSink?: (line: string) => void,
  ) {}

  private persistence(): Promise<SessionPersistence> {
    return awaitService<SessionPersistence>(this.ctx, 'sessionPersistence');
  }

  /**
   * 探测 sessionQuery 是否真的提供 readTitleSnapshots，结论与已解析的服务一起缓存。
   * 只记录一次诊断日志；探测失败（服务未就绪/方法不存在）判为能力缺失，不抛出。
   */
  private probeTitleCapability(): Promise<TitleCapability> {
    if (this.titleCapability === undefined) {
      this.titleCapability = (async (): Promise<TitleCapability> => {
        try {
          const query = await awaitService<SessionQueryLike>(this.ctx, 'sessionQuery');
          const readTitleSnapshots = query.readTitleSnapshots;
          if (typeof readTitleSnapshots !== 'function') {
            return { available: false, reason: 'sessionQuery 无 readTitleSnapshots 方法' };
          }
          return { available: true, readTitleSnapshots: (sessionIds, signal) => readTitleSnapshots.call(query, sessionIds, signal) };
        } catch (error) {
          return { available: false, reason: error instanceof Error ? error.message : String(error) };
        }
      })();
      void this.titleCapability.then((capability) => {
        this.logTitleDiagnostic([], new Map(), capability.available ? undefined : new Error(`title 能力缺失：${capability.reason}`));
      });
    }
    return this.titleCapability;
  }

  /** 全部持久化会话快照（轻量头信息，不读完整事件日志）。 */
  async listSnapshots(): Promise<SessionSnapshot[]> {
    const persistence = await this.persistence();
    const snapshots = await persistence.list();
    return snapshots.map((snapshot) => {
      const record = snapshot as unknown as Record<string, unknown>;
      const header = record['header'] as Record<string, unknown> | undefined;
      return {
        sessionId: String(record['sessionId'] ?? header?.['id'] ?? ''),
        cwd: typeof header?.['cwd'] === 'string' ? (header['cwd'] as string) : undefined,
        createdAt: typeof header?.['createdAt'] === 'number' ? (header['createdAt'] as number) : undefined,
        revision: record['revision'],
        sizeBytes: typeof record['sizeBytes'] === 'number' ? (record['sizeBytes'] as number) : undefined,
      };
    });
  }

  /** 会话是否存在（持久层视角，与运行时活动状态互补）。 */
  async sessionExists(sessionId: string): Promise<boolean> {
    const snapshots = await this.listSnapshots();
    return snapshots.some((snapshot) => snapshot.sessionId === sessionId);
  }

  /**
   * 批量读取会话标题（与 DSH 侧边栏显示的会话名同源：log-backed session/title 折叠）。
   * 能力缺失（本宿主实况）静默返回空 Map；读取失败返回空 Map 并记诊断日志——
   * 两种情况调用方都降级到 projcache / 派生标签。
   */
  async readTitles(sessionIds: readonly string[]): Promise<Map<string, string>> {
    if (sessionIds.length === 0) return new Map();
    const capability = await this.probeTitleCapability();
    if (!capability.available) return new Map();
    try {
      const results = await capability.readTitleSnapshots(sessionIds as SessionId[]);
      const titles = new Map<string, string>();
      for (const item of results) {
        const title = item.title?.title;
        if (typeof title === 'string' && title.trim() !== '') {
          titles.set(String(item.sessionId), title.trim());
        }
      }
      this.logTitleDiagnostic(sessionIds, titles);
      return titles;
    } catch (error) {
      this.logTitleDiagnostic(sessionIds, new Map(), error);
      return new Map();
    }
  }

  /**
   * 读 DSH 会话标题缓存（session_projcache/sessions/<id>.json 的 record.rows.title.val，
   * 即 DSH 侧边栏自动生成的会话摘要名）。单文件缺失/畸形静默跳过；目录不可达返回空 Map。
   */
  async readCachedTitles(sessionIds: readonly string[]): Promise<Map<string, string>> {
    if (sessionIds.length === 0) return new Map();
    const titles = new Map<string, string>();
    const cacheDir = await this.resolveProjcacheDir();
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        const raw = await readFile(path.join(cacheDir, `${sessionId}.json`), 'utf8');
        const parsed = JSON.parse(raw) as { record?: { rows?: { title?: { val?: unknown } } } };
        const title = parsed.record?.rows?.title?.val;
        if (typeof title === 'string' && title.trim() !== '') titles.set(sessionId, title.trim());
      } catch {
        // 单文件缺失/畸形跳过——标题缺席属正常（新会话可能尚未生成摘要）
      }
    }));
    return titles;
  }

  /** projcache 目录解析：注入优先，其次 dsh-home-paths，降级 ~/.dsh。 */
  private async resolveProjcacheDir(): Promise<string> {
    if (this.projcacheDir !== undefined) return this.projcacheDir;
    try {
      const mod = await import('@deepseek-ai/dsh-home-paths');
      const path = await import('node:path');
      return path.join(mod.resolveDshHome(), 'storages', 'session_projcache', 'sessions');
    } catch {
      const os = await import('node:os');
      const path = await import('node:path');
      return path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
    }
  }

  /** 标题读取诊断：写入注入的 sink，缺省追加 marker 文件（排障用；单行追加）。 */
  private async logTitleDiagnostic(requested: readonly string[], obtained: Map<string, string>, error?: unknown): Promise<void> {
    const detail = error !== undefined
      ? `error:${error instanceof Error ? error.message : String(error)}`
      : `ok:${obtained.size}/${requested.length}`;
    const line = `${new Date().toISOString()} [title-lookup] ${detail}`;
    if (this.titleSink !== undefined) {
      this.titleSink(line);
      return;
    }
    try {
      const { appendFile, mkdir } = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const file = path.join(os.homedir(), '.dsh', 'global-supervisor-load.log');
      await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
      await appendFile(file, `${line}\n`, 'utf8').catch(() => undefined);
    } catch {
      // 诊断自身失败不阻断主流程
    }
  }
}
