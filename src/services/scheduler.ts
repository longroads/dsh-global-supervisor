/**
 * Scheduler 服务：巡检调度与对账（方案 §6.5）。
 * Host Schedule 负责定时投递（目标 = Router 会话），本层负责绑定簿记与双向对账；
 * 规则：同一业务巡检一个有效绑定；投递成功 ≠ 任务完成（完成只认 worker_report）。
 */
import type { DshScheduleAdapter } from '../adapters/dsh-schedule.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from '../utils/id.js';
import { normalizeScheduleTiming } from '../protocols/schedule-timing.js';
import { ScheduleBindingRepository } from '../database/repository/schedule-binding-repository.js';
import type { ScheduleBindingRow } from '../database/repository/schedule-binding-repository.js';

/** 绑定视图 = 本地绑定 ⨝ Host 任务现状。 */
export interface BindingView {
  bindingId: string;
  kind: ScheduleBindingRow['kind'];
  dshScheduleId: string;
  active: boolean;
  hostStatus: string | undefined;
  title: string | undefined;
  nextOccurrence: string | undefined;
}

/** 对账结果。 */
export interface ScheduleReconcileResult {
  intact: number;
  remoteMissing: Array<{ bindingId: string; dshScheduleId: string }>;
  adopted: number;
}

export class SchedulerService {
  readonly bindings: ScheduleBindingRepository;

  constructor(private readonly adapter: DshScheduleAdapter, private readonly db: DatabaseSync) {
    this.bindings = new ScheduleBindingRepository(db);
  }

  /**
   * 建立 Router 巡检调度：Host 任务投递到 Router 会话（session 目标）。
   * timing 接受模型友好形态（如 {kind:'daily', time:'09:00'}），由归一化器映射到 Host 真实契约。
   * @returns Host 任务 ID（已登记绑定）
   */
  async setRouterReview(input: {
    title: string;
    prompt: string;
    timing: unknown;
    routerSessionId: string;
    scopeJson?: string;
  }): Promise<string> {
    const timing = normalizeScheduleTiming(input.timing);
    const entry = await this.adapter.createTask(
      {
        title: input.title,
        prompt: input.prompt,
        timing,
        target: { kind: 'session', sessionId: input.routerSessionId },
      },
      input.routerSessionId,
    );
    this.bindings.upsert({
      id: `sb-${randomUUID()}`,
      kind: 'router-review',
      dshScheduleId: entry.id,
      scopeJson: input.scopeJson ?? '{}',
      eventIdTemplate: `schedule:${entry.id}:{{occurrence}}`,
    });
    return entry.id;
  }

  /** 绑定视图列表（⨝ catalog 实时状态）。 */
  async listBindings(activeOnly = true): Promise<BindingView[]> {
    const catalog = await this.adapter.catalog();
    const byScheduleId = new Map(catalog.map((entry) => [entry.id as string, entry]));
    return this.bindings.list(activeOnly).map((binding) => {
      const host = byScheduleId.get(binding.dsh_schedule_id);
      return {
        bindingId: binding.id,
        kind: binding.kind,
        dshScheduleId: binding.dsh_schedule_id,
        active: binding.active === 1,
        hostStatus: host?.status,
        title: host?.title,
        nextOccurrence: nextOccurrenceOf(host),
      };
    });
  }

  /** 停用绑定并删除 Host 任务。 */
  async removeBinding(bindingId: string): Promise<void> {
    const all = this.bindings.list(false);
    const binding = all.find((row) => row.id === bindingId);
    if (!binding) return;
    await this.adapter.edit({ id: binding.dsh_schedule_id, action: 'delete' });
    this.bindings.deactivate(bindingId);
  }

  /**
   * 对账：本地绑定与 Host catalog 双向核对。
   * 远端消失 → 停用本地绑定；本地缺失的 Host 任务不自动收编（避免误认他源任务）。
   */
  async reconcile(): Promise<ScheduleReconcileResult> {
    const catalog = await this.adapter.catalog();
    const hostIds = new Set(catalog.map((entry) => entry.id as string));
    const remoteMissing: Array<{ bindingId: string; dshScheduleId: string }> = [];
    let intact = 0;
    for (const binding of this.bindings.list(true)) {
      if (hostIds.has(binding.dsh_schedule_id)) {
        intact += 1;
        this.bindings.touchReconciled(binding.id);
      } else {
        this.bindings.deactivate(binding.id);
        remoteMissing.push({ bindingId: binding.id, dshScheduleId: binding.dsh_schedule_id });
      }
    }
    return { intact, remoteMissing, adopted: 0 };
  }
}

/** 从 catalog 条目提取下一次出现时间（rrule/daily 等记录形态不一，安全探测）。 */
function nextOccurrenceOf(entry: { scheduledAt?: string; nextScheduledAt?: string } | undefined): string | undefined {
  return entry?.nextScheduledAt ?? entry?.scheduledAt;
}
