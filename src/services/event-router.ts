/**
 * EventRouter：事件路由决策层（ITERATION_PLAN Phase 2——简化 Eval）。
 * 两层判断：代码层规则过滤（event_routing_rules 表）+ Router 决策（followup 后自行调工具）。
 * observe 模式（默认）只评估并留痕不派发；auto 模式按规则 followup 到 Router 或指定会话。
 */
import type { DatabaseSync } from 'node:sqlite';
import { AuditRepository } from '../database/repository/audit-repository.js';
import { EventRepository } from '../database/repository/event-repository.js';
import { EventRoutingRuleRepository } from '../database/repository/event-routing-rule-repository.js';
import type { EventRoutingAction, EventRoutingRuleRow } from '../database/repository/event-routing-rule-repository.js';
import { PluginSettingRepository } from '../database/repository/plugin-setting-repository.js';
import { ThreadSubscriptionRepository } from '../database/repository/thread-subscription-repository.js';
import type { ThreadSubscriber } from '../database/repository/thread-subscription-repository.js';
import type { EventBatcher } from './event-batcher.js';
import type { EventRow } from '../types/index.js';

/** 事件派发目标（DshAgentAdapter 的 dispatch 最小面，便于测试替身）。 */
export interface EventDispatchTarget {
  dispatch(sessionId: string, text: string): Promise<void>;
}

/** 路由结果（与 audit_logs.action 一致的机器可判别值）。 */
export type RouteOutcome = 'event.pending' | 'event.observed' | 'event.routed' | 'event.ignored' | 'event.passed_through';

/** supervisor_event_list 的单行视图（状态由该事件最新一条审计派生）。 */
export interface EventWithStatus {
  event_id: string;
  source: string;
  type: string;
  created_at: string;
  payload_excerpt: string;
  status: 'pending' | 'observed' | 'routed' | 'ignored' | 'passed_through';
}

const MODE_KEY = 'eventRoutingMode';

export class EventRouter {
  readonly rules: EventRoutingRuleRepository;
  private readonly settings: PluginSettingRepository;
  private readonly audit: AuditRepository;
  private readonly events: EventRepository;
  private readonly threadSubs: ThreadSubscriptionRepository;

  constructor(
    db: DatabaseSync,
    private readonly agents: EventDispatchTarget,
    private readonly resolveRouterSession: () => string,
    /** 可选批处理器：route_to_router 命中时合批投递（Phase 5-A，缺省直发） */
    private readonly batcher?: EventBatcher,
  ) {
    this.rules = new EventRoutingRuleRepository(db);
    this.settings = new PluginSettingRepository(db);
    this.audit = new AuditRepository(db);
    this.events = new EventRepository(db);
    this.threadSubs = new ThreadSubscriptionRepository(db);
  }

  /**
   * 写入闭环种子规则（FB-4，幂等，由启动序列显式调用）：规则表为空且用户从未保存过
   * 自定义规则时，预置 supervisor 自身闭环事件 → route_to_router。
   * 默认 observe 模式下仅留痕（安全）；切换 auto 后即生效派发。
   * 闭环通知另有硬接线（worker-report-tool / ProjectMonitor 直连 notifier），不依赖本规则。
   */
  async ensureCoreRules(): Promise<void> {
    if (this.rules.list().length > 0) return;
    if (this.audit.byAction('event.rule.save').length > 0) return;
    const seeds: Array<{ sourcePattern: string; description: string }> = [
      { sourcePattern: 'internal.worker_report.rejected', description: 'Worker 汇报被拒（预置闭环规则）' },
      { sourcePattern: 'internal.task.terminal', description: '任务终态变化（预置闭环规则）' },
      { sourcePattern: 'internal.task.watchdog_retry', description: '看门狗判死重试（预置闭环规则）' },
    ];
    for (const seed of seeds) {
      await this.rules.save({ sourcePattern: seed.sourcePattern, action: 'route_to_router', description: seed.description });
    }
    this.audit.log({ actorRole: 'system', action: 'event.rule.seed', targetType: 'eventRoutingRule', targetId: 'core-rules', detailJson: JSON.stringify({ count: seeds.length }) });
  }

  /** 当前路由模式（默认 observe——安全机制）。 */
  mode(): 'observe' | 'auto' {
    return this.settings.getJson<'observe' | 'auto'>(MODE_KEY) ?? 'observe';
  }

  /** 切换模式（KV 持久化 + 审计）。 */
  setMode(mode: 'observe' | 'auto', actorSessionId?: string): void {
    this.settings.setJson(MODE_KEY, mode);
    this.audit.log({ actorSessionId, actorRole: 'router', action: 'event.mode.set', targetType: 'eventRoutingMode', targetId: mode, detailJson: JSON.stringify({ mode }) });
  }

  /** 保存路由规则（含审计）。 */
  async saveRule(input: { sourcePattern: string; action: EventRoutingAction; targetSessionId?: string; description?: string; enabled?: boolean }, actorSessionId: string): Promise<EventRoutingRuleRow> {
    const rule = await this.rules.save(input);
    this.audit.log({
      actorSessionId,
      actorRole: 'router',
      action: 'event.rule.save',
      targetType: 'eventRoutingRule',
      targetId: rule.id,
      detailJson: JSON.stringify({ pattern: rule.source_pattern, action: rule.action, target: rule.target_session_id, enabled: rule.enabled }),
    });
    return rule;
  }

  /** 事件到达后的路由决策（永不抛错——派发失败降级 pending 并记入审计）。 */
  async route(event: EventRow): Promise<RouteOutcome> {
    const passThrough = await this.routeThreadPassThrough(event);
    if (passThrough !== undefined) return passThrough;
    const rule = this.rules.match(event.source, event.type);
    if (!rule) {
      this.audit.log({ actorRole: 'system', action: 'event.pending', targetType: 'event', targetId: event.event_id });
      return 'event.pending';
    }
    if (this.mode() === 'observe' || rule.action === 'observe') {
      this.audit.log({
        actorRole: 'system',
        action: 'event.observed',
        targetType: 'event',
        targetId: event.event_id,
        detailJson: JSON.stringify({ ruleId: rule.id, pattern: rule.source_pattern, would: rule.action, target: rule.target_session_id }),
      });
      return 'event.observed';
    }
    if (rule.action === 'ignore') {
      this.audit.log({ actorRole: 'system', action: 'event.ignored', targetType: 'event', targetId: event.event_id, detailJson: JSON.stringify({ ruleId: rule.id, pattern: rule.source_pattern }) });
      return 'event.ignored';
    }
    if (rule.action === 'route_to_router' && this.batcher !== undefined) {
      this.batcher.add(event);
      this.audit.log({
        actorRole: 'system',
        action: 'event.routed',
        targetType: 'event',
        targetId: event.event_id,
        detailJson: JSON.stringify({ ruleId: rule.id, pattern: rule.source_pattern, action: rule.action, batched: true }),
      });
      return 'event.routed';
    }
    const targetSession = rule.action === 'route_to_worker' ? rule.target_session_id : this.resolveRouterSession();
    if (!targetSession) {
      this.audit.log({ actorRole: 'system', action: 'event.pending', targetType: 'event', targetId: event.event_id, detailJson: JSON.stringify({ ruleId: rule.id, reason: 'no-target-session' }) });
      return 'event.pending';
    }
    let failure = '';
    try {
      await this.agents.dispatch(targetSession, buildEventNotice(event));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const routed = failure === '';
    this.audit.log({
      actorRole: 'system',
      action: routed ? 'event.routed' : 'event.pending',
      targetType: 'event',
      targetId: event.event_id,
      detailJson: JSON.stringify({ ruleId: rule.id, pattern: rule.source_pattern, action: rule.action, target: targetSession, failure }),
    });
    return routed ? 'event.routed' : 'event.pending';
  }

  /**
   * Thread 直通（最高优先级）：事件所属 Thread 有 running 且已派发会话的订阅者时，
   * 事件直投其 Worker 会话且不经 Router。无无可投订阅者时返回 undefined——事件继续走规则路由（不丢事件）。
   */
  private async routeThreadPassThrough(event: EventRow): Promise<RouteOutcome | undefined> {
    if (event.thread_id === null) return undefined;
    const dispatchable = this.threadSubs
      .runningSubscribers(event.thread_id)
      .filter((s): s is ThreadSubscriber & { assigned_session_id: string } => s.assigned_session_id !== null);
    if (dispatchable.length === 0) return undefined;
    if (this.mode() === 'observe') {
      this.audit.log({
        actorRole: 'system',
        action: 'event.observed',
        targetType: 'event',
        targetId: event.event_id,
        detailJson: JSON.stringify({ passedThrough: true, would: 'thread_pass_through', targets: dispatchable.map((s) => s.assigned_session_id) }),
      });
      return 'event.observed';
    }
    const targets: Array<{ taskId: string; sessionId: string; failure?: string }> = [];
    for (const subscriber of dispatchable) {
      try {
        await this.agents.dispatch(subscriber.assigned_session_id, buildThreadPassNotice(event));
        targets.push({ taskId: subscriber.task_id, sessionId: subscriber.assigned_session_id });
      } catch (error) {
        targets.push({ taskId: subscriber.task_id, sessionId: subscriber.assigned_session_id, failure: error instanceof Error ? error.message : String(error) });
      }
    }
    const succeeded = targets.filter((t) => t.failure === undefined);
    if (succeeded.length === 0) {
      this.audit.log({
        actorRole: 'system',
        action: 'event.pending',
        targetType: 'event',
        targetId: event.event_id,
        detailJson: JSON.stringify({ threadId: event.thread_id, passedThrough: true, failure: targets.map((t) => t.failure).join('; ') }),
      });
      return 'event.pending';
    }
    this.audit.log({
      actorRole: 'system',
      action: 'event.passed_through',
      targetType: 'event',
      targetId: event.event_id,
      detailJson: JSON.stringify({ threadId: event.thread_id, targets }),
    });
    return 'event.passed_through';
  }

  /** 事件流水 + 每条的路由状态（可选按来源/状态过滤）。 */
  listEventsWithStatus(source: string | undefined, limit: number, statusFilter: string | undefined): EventWithStatus[] {
    const rows = this.events.listFiltered(source, limit);
    const result: EventWithStatus[] = [];
    for (const row of rows) {
      const audits = this.audit.byTarget('event', row.event_id);
      const status = deriveStatusFromAuditActions(audits.map((a) => a.action));
      if (statusFilter !== undefined && statusFilter !== status) continue;
      result.push({
        event_id: row.event_id,
        source: row.source,
        type: row.type,
        created_at: row.created_at,
        payload_excerpt: row.payload_json.slice(0, 200),
        status,
      });
    }
    return result;
  }
}

/** 由该事件的审计 action 序列派生最终状态（'event.*' 前缀之外的动作如 mode.set 不参与——按 targetType 隔离已保证）。 */
function deriveStatusFromAuditActions(actions: string[]): EventWithStatus['status'] {
  const latest = actions[actions.length - 1];
  if (latest === 'event.passed_through') return 'passed_through';
  if (latest === 'event.observed') return 'observed';
  if (latest === 'event.routed') return 'routed';
  if (latest === 'event.ignored') return 'ignored';
  return 'pending';
}

/** followup 通知正文（来源/类型/ID + 负载摘要截断）。 */
function buildEventNotice(event: EventRow): string {
  return `【supervisor 事件】${event.source}.${event.type}（${event.event_id}）\n${event.payload_json.slice(0, 300)}\n处理可用 supervisor_task_create / supervisor_event_list；噪音可用 supervisor_event_rule_save 建 ignore 规则。`;
}

/** Thread 直通通知正文（投给 Worker 会话；负载摘要截断更长）。 */
function buildThreadPassNotice(event: EventRow): string {
  return `【Thread 直通】${event.source}.${event.type}（${event.event_id}）\n${event.payload_json.slice(0, 2000)}`;
}
