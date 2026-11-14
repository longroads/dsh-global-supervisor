/**
 * ScheduleService 适配器（Host-wide Schedule，仅 0.2.x）：定时任务管理的唯一触达点。
 * 对账语义（schedule_bindings 与本地库双向核对）在服务层，本层只做通道与类型收窄。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleEditRequest, ScheduleEditResult } from '@deepseek-ai/dsh-schedule';
import { awaitService } from './host-services.js';

export class DshScheduleAdapter {
  constructor(private readonly ctx: Context) {}

  private schedule(): Promise<{ create: (r: ScheduleCreateRequest, actor?: string) => Promise<ScheduleCatalogEntry>; catalog: () => Promise<ScheduleCatalogEntry[]>; edit: (r: ScheduleEditRequest, actor?: string) => Promise<ScheduleEditResult>; run: (r: { id: string }) => Promise<unknown> }> {
    return awaitService(this.ctx, 'schedule');
  }

  /** 全量 Host 任务（读操作不激活目标会话）。 */
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    const schedule = await this.schedule();
    return schedule.catalog();
  }

  /** 创建任务（actorSessionId 记录操作来源会话）。 */
  async createTask(request: ScheduleCreateRequest, actorSessionId?: string): Promise<ScheduleCatalogEntry> {
    const schedule = await this.schedule();
    return schedule.create(request, actorSessionId);
  }

  /** 暂停/恢复/改规则/删除（edit 通道，expectedUpdatedAt 乐观锁由调用方携带）。 */
  async edit(request: ScheduleEditRequest, actorSessionId?: string): Promise<ScheduleEditResult> {
    const schedule = await this.schedule();
    return schedule.edit(request, actorSessionId);
  }

  /** 立即投递一次（不消耗计划中的下一次出现）。 */
  async runNow(scheduleId: string): Promise<unknown> {
    const schedule = await this.schedule();
    return schedule.run({ id: scheduleId });
  }
}
