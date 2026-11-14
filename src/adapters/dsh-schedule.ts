/**
 * ScheduleService 适配器（Host-wide Schedule，仅 0.2.x）：定时任务管理的唯一触达点。
 * 对账语义（schedule_bindings 与本地库双向核对）在服务层；
 * 本层负责品牌类型转换（SessionId/ScheduleId），业务层只使用纯 string。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleEditRequest, ScheduleEditResult, ScheduleTargetRequest } from '@deepseek-ai/dsh-schedule';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { awaitService } from './host-services.js';

/** 业务侧创建请求（target 用纯 string 会话 ID）。 */
export type SchedulerCreateInput = Omit<ScheduleCreateRequest, 'target'> & {
  target?: { kind: 'session'; sessionId: string } | { kind: 'new_once'; create?: { cwd?: string; agentPreset?: string } } | { kind: 'new'; create?: { cwd?: string; agentPreset?: string } };
};

/** 业务侧编辑请求（ID 用纯 string）。 */
export interface SchedulerEditInput {
  id: string;
  action: 'update' | 'delete';
  patch?: { title?: string; prompt?: string; timing?: ScheduleCreateRequest['timing']; active?: boolean };
  expectedUpdatedAt?: string | null;
}

interface HostSchedule {
  create(request: ScheduleCreateRequest, actorSessionId?: SessionId, signal?: AbortSignal): Promise<ScheduleCatalogEntry>;
  catalog(): Promise<ScheduleCatalogEntry[]>;
  edit(request: ScheduleEditRequest, actorSessionId?: SessionId, signal?: AbortSignal): Promise<ScheduleEditResult>;
  run(request: { id: ScheduleEditRequest['id'] }, signal?: AbortSignal): Promise<unknown>;
}

export class DshScheduleAdapter {
  constructor(private readonly ctx: Context) {}

  private schedule(): Promise<HostSchedule> {
    return awaitService<HostSchedule>(this.ctx, 'schedule');
  }

  /** 全量 Host 任务（读操作不激活目标会话）。 */
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    const schedule = await this.schedule();
    return schedule.catalog();
  }

  /** 创建任务（actorSessionId 记录操作来源会话）。 */
  async createTask(request: SchedulerCreateInput, actorSessionId?: string): Promise<ScheduleCatalogEntry> {
    const schedule = await this.schedule();
    const target = request.target === undefined
      ? undefined
      : request.target.kind === 'session'
        ? { kind: 'session', sessionId: request.target.sessionId as SessionId }
        : request.target;
    return schedule.create({ ...request, target: target as ScheduleTargetRequest | undefined }, actorSessionId as SessionId | undefined);
  }

  /** 暂停/恢复/改规则/删除（edit 通道）。 */
  async edit(request: SchedulerEditInput, actorSessionId?: string): Promise<ScheduleEditResult> {
    const schedule = await this.schedule();
    return schedule.edit(
      { id: request.id, action: request.action, patch: request.patch, expectedUpdatedAt: request.expectedUpdatedAt } as ScheduleEditRequest,
      actorSessionId as SessionId | undefined,
    );
  }

  /** 立即投递一次（不消耗计划中的下一次出现）。 */
  async runNow(scheduleId: string): Promise<unknown> {
    const schedule = await this.schedule();
    return schedule.run({ id: scheduleId as ScheduleEditRequest['id'] });
  }
}
