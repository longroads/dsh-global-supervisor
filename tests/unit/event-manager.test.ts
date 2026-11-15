import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import { EventManager } from '../../src/services/event-manager.js';
import type { EventRow } from '../../src/types/index.js';

async function setup(): Promise<{ manager: EventManager; db: Awaited<ReturnType<typeof openDatabase>> }> {
  const db = await openDatabase(':memory:');
  return { manager: new EventManager(db), db };
}

describe('EventManager 去重与路由', () => {
  it('重复 event_id 短路：不落库不派发', async () => {
    const { manager, db } = await setup();
    const seen: string[] = [];
    manager.on('schedule.fired', (e) => { seen.push(e.event_id); });
    const first = await manager.ingest({ eventId: 'occ-1', source: 'schedule', type: 'schedule.fired' });
    const second = await manager.ingest({ eventId: 'occ-1', source: 'schedule', type: 'schedule.fired' });
    expect(first.inserted).toBe(true);
    expect(first.dispatched).toBe(1);
    expect(second).toEqual({ inserted: false, dispatched: 0, errors: [] });
    expect(seen).toEqual(['occ-1']);
    expect(manager.repository.countByType('schedule.fired')).toBe(1);
    db.close();
  });

  it('精确匹配与 schedule.* 前缀通配同时生效', async () => {
    const { manager, db } = await setup();
    const exact: string[] = [];
    const wildcard: string[] = [];
    manager.on('schedule.fired', (e) => { exact.push(e.event_id); });
    manager.on('schedule.*', (e) => { wildcard.push(e.event_id); });
    manager.on('worker.reported', () => { wildcard.push('不应匹配'); });
    await manager.ingest({ eventId: 'occ-2', source: 'schedule', type: 'schedule.fired' });
    expect(exact).toEqual(['occ-2']);
    expect(wildcard).toEqual(['occ-2']);
    db.close();
  });

  it('handler 抛错被收集，不阻断其他 handler', async () => {
    const { manager, db } = await setup();
    let secondRan = false;
    manager.on('agent.error', () => { throw new Error('handler-1 炸了'); });
    manager.on('agent.error', () => { secondRan = true; });
    const result = await manager.ingest({ eventId: 'evt-1', source: 'agent', type: 'agent.error' });
    expect(result.inserted).toBe(true);
    expect(result.dispatched).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0] as Error).message).toContain('handler-1');
    expect(secondRan).toBe(true);
    db.close();
  });

  it('落库行携带负载与关联字段', async () => {
    const { manager, db } = await setup();
    let captured: EventRow | undefined;
    manager.on('task.timeout', (e) => { captured = e; });
    await manager.ingest({
      eventId: 'to-1',
      source: 'system',
      type: 'task.timeout',
      workspaceId: 'ws-9',
      taskId: 'task-001',
      payloadJson: '{"timeoutMs":1800000}',
    });
    expect(captured?.workspace_id).toBe('ws-9');
    expect(captured?.task_id).toBe('task-001');
    expect(captured?.payload_json).toContain('1800000');
    db.close();
  });

  it('路由元数据（thread/channel/actor/human）随事件落库', async () => {
    const { manager, db } = await setup();
    await manager.ingest({
      eventId: 'wh-1',
      source: 'webhook',
      type: 'issue.opened',
      threadId: 'gh-42',
      channelRef: 'webhook:github',
      actorJson: '{"id":"u1","name":"alice"}',
      human: true,
    });
    const row = manager.repository.byEventId('wh-1');
    expect(row?.thread_id).toBe('gh-42');
    expect(row?.channel_ref).toBe('webhook:github');
    expect(row?.actor_json).toBe('{"id":"u1","name":"alice"}');
    expect(row?.human).toBe(1);
    db.close();
  });
});
