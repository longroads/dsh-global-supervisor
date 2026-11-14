/**
 * SessionPersistence 适配器：持久化会话快照查询的唯一触达点
 * （Workspace 归属核对与冷恢复前的存在性检查）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { awaitService } from './host-services.js';

/** 会话查询服务面（readTitleSnapshots = DSH 侧边栏会话名的同源读取）。 */
interface SessionQueryLike {
  readTitleSnapshots(sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<Array<{ sessionId: SessionId; status: string; title?: { title: string; source: string } }>>;
}

/** 会话快照纯数据视图。 */
export interface SessionSnapshot {
  sessionId: string;
  cwd: string | undefined;
  createdAt: number | undefined;
  revision: unknown;
  sizeBytes: number | undefined;
}

export class DshSessionAdapter {
  constructor(private readonly ctx: Context) {}

  private persistence(): Promise<SessionPersistence> {
    return awaitService<SessionPersistence>(this.ctx, 'sessionPersistence');
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
   * 服务不可用或读取失败时返回空 Map——调用方降级到派生标签；失败原因写入诊断日志。
   */
  async readTitles(sessionIds: readonly string[]): Promise<Map<string, string>> {
    if (sessionIds.length === 0) return new Map();
    try {
      const query = await awaitService<SessionQueryLike>(this.ctx, 'sessionQuery');
      const results = await query.readTitleSnapshots(sessionIds as SessionId[]);
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

  /** 标题读取诊断：写入 marker（排障用；单行追加，页面打开一次一条）。 */
  private async logTitleDiagnostic(requested: readonly string[], obtained: Map<string, string>, error?: unknown): Promise<void> {
    try {
      const { appendFile, mkdir } = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const file = path.join(os.homedir(), '.dsh', 'global-supervisor-load.log');
      await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
      const detail = error !== undefined
        ? `error:${error instanceof Error ? error.message : String(error)}`
        : `ok:${obtained.size}/${requested.length}`;
      await appendFile(file, `${new Date().toISOString()} [title-lookup] ${detail}\n`, 'utf8').catch(() => undefined);
    } catch {
      // 诊断自身失败不阻断主流程
    }
  }
}
