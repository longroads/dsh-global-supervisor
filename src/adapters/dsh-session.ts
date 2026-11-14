/**
 * SessionPersistence 适配器：持久化会话快照查询的唯一触达点
 * （Workspace 归属核对与冷恢复前的存在性检查）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { awaitService } from './host-services.js';

/** 会话快照纯数据视图。 */
export interface SessionSnapshot {
  sessionId: string;
  cwd: string | undefined;
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
}
