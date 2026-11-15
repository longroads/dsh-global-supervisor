/**
 * thread_subscriptions 表 Repository：任务与 IM Thread 的订阅关系（直通路由依据，任务完结即退订）。
 */
import type { DatabaseSync } from 'node:sqlite';

function now(): string {
  return new Date().toISOString();
}

/** thread_subscriptions 表行。 */
export interface ThreadSubscriptionRow {
  task_id: string;
  thread_id: string;
  created_at: string;
}

/** running 订阅者投影：任务及其已派发会话（未派发为 null）。 */
export interface ThreadSubscriber {
  task_id: string;
  assigned_session_id: string | null;
}

export class ThreadSubscriptionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 订阅（幂等：同 task_id+thread_id 重复订阅不报错不重复）。 */
  subscribe(taskId: string, threadId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO thread_subscriptions(task_id, thread_id, created_at) VALUES(?, ?, ?)')
      .run(taskId, threadId, now());
  }

  /** 退订该任务的全部 Thread 订阅。 */
  unsubscribeByTask(taskId: string): void {
    this.db.prepare('DELETE FROM thread_subscriptions WHERE task_id = ?').run(taskId);
  }

  /** 该任务订阅的 thread_id 列表。 */
  threadsOfTask(taskId: string): string[] {
    const rows = this.db
      .prepare('SELECT thread_id FROM thread_subscriptions WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as unknown as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  /** 该 Thread 的全部订阅任务 ID（不限状态；召回用）。 */
  tasksForThread(threadId: string): string[] {
    const rows = this.db
      .prepare('SELECT task_id FROM thread_subscriptions WHERE thread_id = ? ORDER BY created_at')
      .all(threadId) as unknown as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /** 该 Thread 下处于 running 状态的订阅者（JOIN tasks，含未派发会话的 running 任务）。 */
  runningSubscribers(threadId: string): ThreadSubscriber[] {
    return this.db
      .prepare(
        `SELECT s.task_id AS task_id, t.assigned_session_id AS assigned_session_id
         FROM thread_subscriptions s JOIN tasks t ON t.id = s.task_id
         WHERE s.thread_id = ? AND t.status = 'running'`,
      )
      .all(threadId) as unknown as ThreadSubscriber[];
  }
}
