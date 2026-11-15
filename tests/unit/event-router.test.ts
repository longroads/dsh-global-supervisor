import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import { AuditRepository } from '../../src/database/repository/audit-repository.js';
import { ProjectRepository } from '../../src/database/repository/project-repository.js';
import { TaskRepository } from '../../src/database/repository/task-repository.js';
import { ThreadSubscriptionRepository } from '../../src/database/repository/thread-subscription-repository.js';
import { EventManager } from '../../src/services/event-manager.js';
import { EventBatcher } from '../../src/services/event-batcher.js';
import { EventRouter } from '../../src/services/event-router.js';
import type { EventDispatchTarget } from '../../src/services/event-router.js';
import type { EventRow } from '../../src/types/index.js';

const ROUTER = 'session-router';

function spyTarget(): { calls: Array<{ sessionId: string; text: string }>; target: EventDispatchTarget } {
  const calls: Array<{ sessionId: string; text: string }> = [];
  return { calls, target: { dispatch: async (sessionId, text) => { calls.push({ sessionId, text }); } } };
}

async function setup(): Promise<{ router: EventRouter; db: Awaited<ReturnType<typeof openDatabase>>; calls: Array<{ sessionId: string; text: string }> }> {
  const db = await openDatabase(':memory:');
  const { calls, target } = spyTarget();
  const router = new EventRouter(db, target, () => ROUTER);
  return { router, db, calls };
}

function whEvent(id: string, source = 'webhook', type = 'issue.opened'): EventRow {
  return { id: 1, event_id: id, source, type, workspace_id: null, task_id: null, payload_json: '{"body":"x"}', dedup_hash: null, thread_id: null, channel_ref: null, actor_json: null, human: 0, created_at: new Date().toISOString() };
}

function actionsOf(db: Awaited<ReturnType<typeof openDatabase>>, eventId: string): string[] {
  return new AuditRepository(db).byTarget('event', eventId).map((a) => a.action);
}

/** 造一个 Thread 订阅者（任务落到指定状态，可选派发会话）并订阅其 Thread。 */
function seedSubscriber(db: Awaited<ReturnType<typeof openDatabase>>, options: { taskId: string; threadId: string; sessionId?: string; status: 'running' | 'queued' }): void {
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const projectId = `proj-${options.taskId}`;
  projects.create({ id: projectId, workspaceId: `ws-${options.taskId}`, name: 'P' });
  tasks.create({ id: options.taskId, projectId, title: 'T' });
  tasks.updateStatus(options.taskId, options.status);
  if (options.sessionId !== undefined) tasks.markDispatched(options.taskId, options.sessionId, null);
  new ThreadSubscriptionRepository(db).subscribe(options.taskId, options.threadId);
}

describe('EventRouter 路由决策', () => {
  it('默认 observe 模式；无规则匹配 → pending，不派发', async () => {
    const { router, db, calls } = await setup();
    expect(router.mode()).toBe('observe');
    const outcome = await router.route(whEvent('wh-1'));
    expect(outcome).toBe('event.pending');
    expect(calls).toHaveLength(0);
    expect(actionsOf(db, 'wh-1')).toEqual(['event.pending']);
    db.close();
  });

  it('observe 模式 + 命中 route_to_router 规则 → 只留痕（would 记录），不派发', async () => {
    const { router, db, calls } = await setup();
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'route_to_router' }, ROUTER);
    const outcome = await router.route(whEvent('wh-2'));
    expect(outcome).toBe('event.observed');
    expect(calls).toHaveLength(0);
    const detail = JSON.parse(new AuditRepository(db).byTarget('event', 'wh-2')[0]?.detail_json ?? '{}') as { would?: string };
    expect(detail.would).toBe('route_to_router');
    db.close();
  });

  it('auto 模式 + route_to_router → followup 到 Router 会话并留痕 routed', async () => {
    const { router, db, calls } = await setup();
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'route_to_router' }, ROUTER);
    router.setMode('auto', ROUTER);
    const outcome = await router.route(whEvent('wh-3'));
    expect(outcome).toBe('event.routed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(ROUTER);
    expect(calls[0]?.text).toContain('webhook.issue.opened');
    expect(actionsOf(db, 'wh-3')).toEqual(['event.routed']);
    db.close();
  });

  it('auto 模式 + route_to_worker → 派发到规则指定会话', async () => {
    const { router, db, calls } = await setup();
    await router.saveRule({ sourcePattern: 'agent.user.*', action: 'route_to_worker', targetSessionId: 'session-worker' }, ROUTER);
    router.setMode('auto', ROUTER);
    const outcome = await router.route(whEvent('wh-4', 'agent', 'user.message'));
    expect(outcome).toBe('event.routed');
    expect(calls[0]?.sessionId).toBe('session-worker');
    db.close();
  });

  it('ignore 规则 → 不派发且留痕 ignored', async () => {
    const { router, db, calls } = await setup();
    await router.saveRule({ sourcePattern: '*', action: 'ignore' }, ROUTER);
    router.setMode('auto', ROUTER);
    const outcome = await router.route(whEvent('wh-5', 'agent', 'tool.result'));
    expect(outcome).toBe('event.ignored');
    expect(calls).toHaveLength(0);
    db.close();
  });

  it('派发失败 → 降级 pending 且 failure 写入审计', async () => {
    const db = await openDatabase(':memory:');
    const failing: EventDispatchTarget = { dispatch: async () => { throw new Error('agent 不可用'); } };
    const router = new EventRouter(db, failing, () => ROUTER);
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'route_to_router' }, ROUTER);
    router.setMode('auto', ROUTER);
    const outcome = await router.route(whEvent('wh-6'));
    expect(outcome).toBe('event.pending');
    const detail = JSON.parse(new AuditRepository(db).byTarget('event', 'wh-6')[0]?.detail_json ?? '{}') as { failure?: string };
    expect(detail.failure).toContain('agent 不可用');
    db.close();
  });

  it('模式持久化：setMode 写入 plugin_settings，重开实例仍生效', async () => {
    const { router, db } = await setup();
    router.setMode('auto', ROUTER);
    const reopened = new EventRouter(db, { dispatch: async () => undefined }, () => ROUTER);
    expect(reopened.mode()).toBe('auto');
    db.close();
  });
});

describe('EventRoutingRuleRepository 规则匹配', () => {
  it('精确 / 尾缀 .* 前缀 / 裸 *（按保存顺序取首条命中）', async () => {
    const { router, db } = await setup();
    await router.saveRule({ sourcePattern: 'webhook.issue.opened', action: 'ignore' }, ROUTER);
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'observe' }, ROUTER);
    await router.saveRule({ sourcePattern: '*', action: 'route_to_router' }, ROUTER);
    expect(router.rules.match('webhook', 'issue.opened')?.source_pattern).toBe('webhook.issue.opened');
    expect(router.rules.match('webhook', 'push.committed')?.source_pattern).toBe('webhook.*');
    expect(router.rules.match('agent', 'user.message')?.source_pattern).toBe('*');
    db.close();
  });

  it('同 pattern 重复保存覆盖动作（规则数不增）', async () => {
    const { router, db } = await setup();
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'route_to_router' }, ROUTER);
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'ignore' }, ROUTER);
    const rules = router.rules.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.action).toBe('ignore');
    db.close();
  });
});

describe('EventRouter 事件流水视图', () => {
  it('listEventsWithStatus：状态由审计派生并支持来源/状态过滤', async () => {
    const { router, db } = await setup();
    const manager = new EventManager(db);
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'ignore' }, ROUTER);
    router.setMode('auto', ROUTER);
    await manager.ingest({ eventId: 'wh-a', source: 'webhook', type: 'issue.opened' });
    await manager.ingest({ eventId: 'ev-b', source: 'agent', type: 'user.message' });
    await router.route(manager.repository.byEventId('wh-a') as EventRow);
    const all = router.listEventsWithStatus(undefined, 10, undefined);
    expect(all).toHaveLength(2);
    const byId = new Map(all.map((e) => [e.event_id, e.status]));
    expect(byId.get('wh-a')).toBe('ignored');
    expect(byId.get('ev-b')).toBe('pending');
    expect(router.listEventsWithStatus('webhook', 10, undefined)).toHaveLength(1);
    expect(router.listEventsWithStatus(undefined, 10, 'pending')).toHaveLength(1);
    db.close();
  });
});

describe('EventRouter Thread 直通', () => {
  it('auto 模式：直投订阅者 Worker（不经 Router，规则不再评估）', async () => {
    const { router, db, calls } = await setup();
    seedSubscriber(db, { taskId: 'task-1', threadId: 'th-x', sessionId: 'session-worker', status: 'running' });
    await router.saveRule({ sourcePattern: '*', action: 'route_to_router' }, ROUTER);
    router.setMode('auto', ROUTER);
    const outcome = await router.route({ ...whEvent('wh-t1'), thread_id: 'th-x' });
    expect(outcome).toBe('event.passed_through');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe('session-worker');
    expect(calls.some((c) => c.sessionId === ROUTER)).toBe(false);
    expect(calls[0]?.text).toContain('wh-t1');
    expect(actionsOf(db, 'wh-t1')).toEqual(['event.passed_through']);
    db.close();
  });

  it('observe 模式：直通只留痕不派发（would 含目标会话）', async () => {
    const { router, db, calls } = await setup();
    seedSubscriber(db, { taskId: 'task-1', threadId: 'th-x', sessionId: 'session-worker', status: 'running' });
    const outcome = await router.route({ ...whEvent('wh-t2'), thread_id: 'th-x' });
    expect(outcome).toBe('event.observed');
    expect(calls).toHaveLength(0);
    const detail = JSON.parse(new AuditRepository(db).byTarget('event', 'wh-t2')[0]?.detail_json ?? '{}') as { passedThrough?: boolean; targets?: string[] };
    expect(detail.passedThrough).toBe(true);
    expect(detail.targets).toContain('session-worker');
    db.close();
  });

  it('订阅者未 running：无可投对象，事件回落规则路由（不丢事件）', async () => {
    const { router, db, calls } = await setup();
    seedSubscriber(db, { taskId: 'task-1', threadId: 'th-x', status: 'queued' });
    const outcome = await router.route({ ...whEvent('wh-t3'), thread_id: 'th-x' });
    expect(outcome).toBe('event.pending');
    expect(calls).toHaveLength(0);
    expect(actionsOf(db, 'wh-t3')).toEqual(['event.pending']);
    db.close();
  });

  it('无订阅者：事件走 Phase 2 规则路由（Router 收到）', async () => {
    const { router, db, calls } = await setup();
    await router.saveRule({ sourcePattern: 'webhook.*', action: 'route_to_router' }, ROUTER);
    router.setMode('auto', ROUTER);
    const outcome = await router.route({ ...whEvent('wh-t4'), thread_id: 'th-y' });
    expect(outcome).toBe('event.routed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(ROUTER);
    db.close();
  });

  it('直通派发全部失败：降级 pending 并记录 failure', async () => {
    const db = await openDatabase(':memory:');
    const failing: EventDispatchTarget = { dispatch: async () => { throw new Error('agent 不可用'); } };
    const router = new EventRouter(db, failing, () => ROUTER);
    seedSubscriber(db, { taskId: 'task-1', threadId: 'th-x', sessionId: 'session-worker', status: 'running' });
    router.setMode('auto', ROUTER);
    const outcome = await router.route({ ...whEvent('wh-t5'), thread_id: 'th-x' });
    expect(outcome).toBe('event.pending');
    const detail = JSON.parse(new AuditRepository(db).byTarget('event', 'wh-t5')[0]?.detail_json ?? '{}') as { failure?: string; threadId?: string };
    expect(detail.threadId).toBe('th-x');
    expect(detail.failure).toContain('agent 不可用');
    db.close();
  });

  it('passed_through 状态在事件流水可见且可过滤', async () => {
    const { router, db } = await setup();
    seedSubscriber(db, { taskId: 'task-1', threadId: 'th-x', sessionId: 'session-worker', status: 'running' });
    router.setMode('auto', ROUTER);
    const manager = new EventManager(db);
    await manager.ingest({ eventId: 'wh-t6', source: 'webhook', type: 'issue.opened', threadId: 'th-x' });
    const row = manager.repository.byEventId('wh-t6');
    if (!row) throw new Error('事件未落库');
    await router.route(row);
    const all = router.listEventsWithStatus(undefined, 10, undefined);
    expect(all.find((e) => e.event_id === 'wh-t6')?.status).toBe('passed_through');
    expect(router.listEventsWithStatus(undefined, 10, 'passed_through')).toHaveLength(1);
    db.close();
  });
});

describe('EventRouter 批式路由（Phase 5-A）', () => {
  it('route_to_router 命中批处理器：合投不经直发通道，审计带 batched 标记', async () => {
    const { db, calls } = await setup();
    const batchCalls: Array<{ sessionId: string; text: string }> = [];
    const batcher = new EventBatcher(
      { dispatch: async (sessionId: string, text: string) => { batchCalls.push({ sessionId, text }); } },
      () => ROUTER,
      { maxBatch: 1, debounceMs: 10 },
    );
    const batchedRouter = new EventRouter(db, { dispatch: async () => undefined }, () => ROUTER, batcher);
    await batchedRouter.saveRule({ sourcePattern: 'webhook.*', action: 'route_to_router' }, ROUTER);
    batchedRouter.setMode('auto', ROUTER);
    const outcome = await batchedRouter.route(whEvent('wh-b1'));
    expect(outcome).toBe('event.routed');
    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.text).toContain('wh-b1');
    const detail = JSON.parse(new AuditRepository(db).byTarget('event', 'wh-b1')[0]?.detail_json ?? '{}') as { batched?: boolean };
    expect(detail.batched).toBe(true);
    db.close();
  });
});
