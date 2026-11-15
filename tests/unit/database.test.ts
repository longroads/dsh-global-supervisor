import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../../src/database/connection.js';
import { EventRepository } from '../../src/database/repository/event-repository.js';
import { ProjectRepository } from '../../src/database/repository/project-repository.js';
import { TaskRepository } from '../../src/database/repository/task-repository.js';
import { TaskRunRepository } from '../../src/database/repository/task-run-repository.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dsh-sup-test-'));
});

afterEach(async () => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('数据库连接与迁移', async () => {
  it(':memory: 打开即迁移到最新版本', async () => {
    const db = await openDatabase(':memory:');
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it('文件库重复打开迁移幂等（schema_version 不重复累计）', async () => {
    const path = join(tmpDir, 'a.db');
    const db1 = await openDatabase(path);
    db1.close();
    const db2 = await openDatabase(path);
    const row = db2.prepare('SELECT COUNT(*) AS n, MAX(version) AS v FROM schema_version').get() as { n: number; v: number };
    expect(row.n).toBe(4);
    expect(row.v).toBeGreaterThanOrEqual(4);
    db2.close();
  });

  it('外键约束生效：无项目的任务插入被拒绝', async () => {
    const db = await openDatabase(':memory:');
    const tasks = new TaskRepository(db);
    expect(() => tasks.create({ id: 'task-x', projectId: 'proj-missing', title: '孤儿任务' })).toThrow();
    db.close();
  });

  it('withTransaction 中途抛错整体回滚', async () => {
    const db = await openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1' });
    expect(() =>
      withTransaction(db, () => {
        projects.create({ id: 'proj-2', workspaceId: 'ws-2', name: 'P2' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(projects.byId('proj-2')).toBeUndefined();
    expect(projects.byId('proj-1')).toBeDefined();
    db.close();
  });
});

describe('ProjectRepository', async () => {
  it('创建/查询/更新/归档全链路', async () => {
    const db = await openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1', priority: 5 });
    const loaded = projects.byWorkspaceId('ws-1');
    expect(loaded?.id).toBe('proj-1');
    expect(loaded?.status).toBe('active');
    expect(loaded?.health).toBe('unknown');
    expect(projects.update('proj-1', { priority: 9, health: 'warning' })).toBe(true);
    expect(projects.byId('proj-1')?.priority).toBe(9);
    expect(projects.archive('proj-1')).toBe(true);
    expect(projects.list().map((p) => p.id)).not.toContain('proj-1');
    expect(projects.list(true).map((p) => p.id)).toContain('proj-1');
    db.close();
  });
});

describe('TaskRepository', async () => {
  it('任务 ID 当日序号递增', async () => {
    const db = await openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1' });
    const first = tasks.nextTaskId();
    tasks.create({ id: first, projectId: 'proj-1', title: 'T1' });
    const second = tasks.nextTaskId();
    expect(second).not.toBe(first);
    expect(second.slice(0, -3)).toBe(first.slice(0, -3));
    expect(Number(second.slice(-3))).toBe(Number(first.slice(-3)) + 1);
    db.close();
  });

  it('状态更新与派发簿记', async () => {
    const db = await openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1' });
    tasks.create({ id: 'task-1', projectId: 'proj-1', title: 'T1' });
    expect(tasks.byId('task-1')?.status).toBe('pending');
    expect(tasks.updateStatus('task-1', 'queued')).toBe(true);
    expect(tasks.updateStatus('task-1', 'running')).toBe(true);
    expect(tasks.markDispatched('task-1', 'session-a', '2026-11-14T12:00:00.000Z')).toBe(true);
    const loaded = tasks.byId('task-1');
    expect(loaded?.status).toBe('running');
    expect(loaded?.assigned_session_id).toBe('session-a');
    expect(tasks.list({ status: 'running' })).toHaveLength(1);
    expect(tasks.list({ projectId: 'proj-1', status: 'pending' })).toHaveLength(0);
    db.close();
  });

  it('依赖登记与自引用拒绝', async () => {
    const db = await openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1' });
    tasks.create({ id: 'task-1', projectId: 'proj-1', title: 'A' });
    tasks.create({ id: 'task-2', projectId: 'proj-1', title: 'B' });
    tasks.addDependency('task-2', 'task-1');
    expect(tasks.dependenciesOf('task-2')).toEqual(['task-1']);
    expect(() => tasks.addDependency('task-1', 'task-1')).toThrow();
    db.close();
  });
});

describe('TaskRunRepository', async () => {
  it('开始/结束/按任务列举，重试产生新记录', async () => {
    const db = await openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const runs = new TaskRunRepository(db);
    projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'P1' });
    tasks.create({ id: 'task-1', projectId: 'proj-1', title: 'T1' });
    const run1 = runs.start({ taskId: 'task-1', sessionId: 'session-a', attemptNo: 1 });
    runs.finish(run1, 'failed', { errorMessage: '超时' });
    const run2 = runs.start({ taskId: 'task-1', sessionId: 'session-a', attemptNo: 2 });
    const history = runs.byTask('task-1');
    expect(history).toHaveLength(2);
    expect(history[0]?.outcome).toBe('failed');
    expect(history[0]?.ended_at).not.toBeNull();
    expect(history[1]?.outcome).toBeNull();
    expect(run2).toBeGreaterThan(run1);
    db.close();
  });
});

describe('EventRepository 去重', async () => {
  it('同 event_id 二次写入返回 false（幂等）', async () => {
    const db = await openDatabase(':memory:');
    const events = new EventRepository(db);
    const first = events.ingest({ eventId: 'sched-occ-001', source: 'schedule', type: 'schedule.fired', workspaceId: 'ws-1' });
    const second = events.ingest({ eventId: 'sched-occ-001', source: 'schedule', type: 'schedule.fired', workspaceId: 'ws-1' });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(events.byEventId('sched-occ-001')).toBeDefined();
    expect(events.countByType('schedule.fired')).toBe(1);
    db.close();
  });
});
