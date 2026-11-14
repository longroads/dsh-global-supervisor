/**
 * Router 身份服务：运行时认领制（USER_GUIDE §3.3 / §5）。
 * 身份存 plugin_settings.router；patch 配置的 routerSessionId 降级为预置回退。
 * 安全模型：首次认领制——无 Router 时任何会话可认领；已有 Router 时仅当前
 * Router 本人可换绑/注销；全部动作审计留痕。
 */
import type { DatabaseSync } from 'node:sqlite';
import { AuditRepository } from '../database/repository/audit-repository.js';
import { PluginSettingRepository } from '../database/repository/plugin-setting-repository.js';

/** Router 身份记录（plugin_settings.router 的值形态）。 */
export interface RouterIdentityRecord {
  mode: 'session' | 'workspace';
  /** 认领会话（session 模式即 Router 本体；workspace 模式为认领发起者） */
  sessionId: string;
  /** workspace 模式：该工作区下全部会话均为 Router */
  workspaceId?: string;
  claimedAt: string;
}

/** 认领/换绑结果（机器消费值）。 */
export interface ClaimResult {
  ok: boolean;
  reason: 'claimed' | 'rebound' | 'already-owner' | 'denied-not-router' | 'workspace-not-found';
}

const SETTING_KEY = 'router';

/** 会话归属判定回调（由 runtime 接 workspaceRegistry.sessionIds 实现）。 */
export type SessionBelongsToWorkspace = (sessionId: string, workspaceId: string) => Promise<boolean>;

export class RouterIdentity {
  readonly settings: PluginSettingRepository;
  private readonly audit: AuditRepository;

  constructor(
    private readonly db: DatabaseSync,
    /** 预置回退（patch 配置的 routerSessionId；无认领记录时生效） */
    private readonly fallbackSessionId: string,
    private readonly belongsTo: SessionBelongsToWorkspace = async () => false,
  ) {
    this.settings = new PluginSettingRepository(db);
    this.audit = new AuditRepository(db);
  }

  /** 当前认领记录（无认领返回 undefined——回退到预置配置）。 */
  current(): RouterIdentityRecord | undefined {
    return this.settings.getJson<RouterIdentityRecord>(SETTING_KEY);
  }

  /** 当前 Router 的代表会话（认领记录优先，回退预置配置；通知与审计用途）。 */
  ownerSessionId(): string {
    return this.current()?.sessionId ?? this.fallbackSessionId;
  }

  /** 会话是否为 Router（认领记录优先；无记录回退预置配置；workspace 模式异步判定归属）。 */
  async isRouter(sessionId: string): Promise<boolean> {
    const record = this.current();
    if (!record) return sessionId === this.fallbackSessionId;
    if (record.mode === 'session') return sessionId === record.sessionId;
    return record.workspaceId !== undefined && (sessionId === record.sessionId || (await this.belongsTo(sessionId, record.workspaceId)));
  }

  /**
   * 认领/换绑：
   * - 无 Router：任何会话可认领（首次认领制）；
   * - 已有 Router：仅当前 Router 可换绑或注销（rebindTo 为空 = 注销）。
   */
  async claim(input: { callerSessionId: string; mode: 'session' | 'workspace'; workspaceId?: string }): Promise<ClaimResult> {
    const existing = this.current();
    if (existing) {
      const callerIsRouter = await this.isRouter(input.callerSessionId);
      if (!callerIsRouter) return { ok: false, reason: 'denied-not-router' };
      if (input.mode === 'session' && existing.mode === 'session' && existing.sessionId === input.callerSessionId) {
        return { ok: true, reason: 'already-owner' };
      }
    }
    const record: RouterIdentityRecord = {
      mode: input.mode,
      sessionId: input.callerSessionId,
      workspaceId: input.mode === 'workspace' ? input.workspaceId : undefined,
      claimedAt: new Date().toISOString(),
    };
    if (input.mode === 'workspace' && !input.workspaceId) {
      return { ok: false, reason: 'workspace-not-found' };
    }
    this.settings.setJson(SETTING_KEY, record);
    this.audit.log({
      actorSessionId: input.callerSessionId,
      actorRole: existing ? 'router' : 'system',
      action: existing ? 'router.rebind' : 'router.claim',
      targetType: 'router-identity',
      targetId: record.mode === 'workspace' ? (record.workspaceId as string) : record.sessionId,
      detailJson: JSON.stringify({ mode: record.mode }),
    });
    return { ok: true, reason: existing ? 'rebound' : 'claimed' };
  }

  /**
   * 管理端指派（设置面板通道）：面板操作视为设置页物理访问授权，
   * 无条件写入身份（不经"本人发起"路径）；审计 actor 为 system。
   */
  assign(input: { mode: 'session' | 'workspace'; sessionId: string; workspaceId?: string }): RouterIdentityRecord {
    const record: RouterIdentityRecord = {
      mode: input.mode,
      sessionId: input.sessionId,
      workspaceId: input.mode === 'workspace' ? input.workspaceId : undefined,
      claimedAt: new Date().toISOString(),
    };
    this.settings.setJson(SETTING_KEY, record);
    this.audit.log({
      actorRole: 'system',
      action: 'router.assign',
      targetType: 'router-identity',
      targetId: record.mode === 'workspace' ? (record.workspaceId as string) : record.sessionId,
      detailJson: JSON.stringify({ mode: record.mode, via: 'settings-panel' }),
    });
    return record;
  }
}
