/**
 * 数据库迁移定义（内嵌 SQL 常量，避免运行时文件路径依赖）。
 *
 * 纪律：只追加不修改——已发布的迁移不可编辑；新变更新增 version 递增条目。
 * 每条迁移在独立事务中执行，成功即写入 schema_version。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 一次迁移：版本号 + 名称 + DDL/DDL 语句组。 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

/** 全部迁移，按 version 升序排列。 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init-八表基线',
    up: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 0 AND 9),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
        worker_session_id TEXT,
        goals_json TEXT NOT NULL DEFAULT '[]',
        health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('ok','warning','blocked','unknown')),
        last_review_at TEXT,
        next_review_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        parent_task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 0 AND 9),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','queued','running','completed','blocked','need_human','failed','canceled')),
        assigned_session_id TEXT,
        schedule_binding_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        timeout_at TEXT,
        due_at TEXT,
        last_report_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
      CREATE INDEX idx_tasks_status ON tasks(status);

      CREATE TABLE task_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          session_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          outcome TEXT CHECK (outcome IN ('completed','failed','timeout','canceled')),
          result_summary TEXT,
          error_message TEXT,
          usage_json TEXT,
          UNIQUE(task_id, attempt_no)
      );
      CREATE INDEX idx_task_runs_task ON task_runs(task_id);

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id <> depends_on_task_id)
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('schedule','im','agent','system','internal')),
        type TEXT NOT NULL,
        workspace_id TEXT,
        task_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        dedup_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_events_created ON events(created_at);
      CREATE INDEX idx_events_workspace ON events(workspace_id);

      CREATE TABLE worker_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER CHECK (progress BETWEEN 0 AND 100),
        summary TEXT,
        blockers_json TEXT NOT NULL DEFAULT '[]',
        need_human INTEGER NOT NULL DEFAULT 0,
        suggested_actions_json TEXT NOT NULL DEFAULT '[]',
        received_at TEXT NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_worker_reports_task ON worker_reports(task_id);

      CREATE TABLE schedule_bindings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('router-review','project-check','custom')),
        dsh_schedule_id TEXT NOT NULL UNIQUE,
        scope_json TEXT NOT NULL DEFAULT '{}',
        event_id_template TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        last_reconciled_at TEXT
      );

      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_session_id TEXT,
        actor_role TEXT NOT NULL CHECK (actor_role IN ('router','worker','system')),
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);
    `,
  },
  {
    version: 2,
    name: 'plugin-settings-KV',
    up: `
      CREATE TABLE plugin_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'events-rebuild-webhook-source-and-routing-rules',
    up: `
      CREATE TABLE events_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('schedule','im','agent','system','internal','webhook')),
        type TEXT NOT NULL,
        workspace_id TEXT,
        task_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        dedup_hash TEXT,
        thread_id TEXT,
        channel_ref TEXT,
        actor_json TEXT,
        human INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO events_rebuilt (event_id, source, type, workspace_id, task_id, payload_json, dedup_hash, created_at)
        SELECT event_id, source, type, workspace_id, task_id, payload_json, dedup_hash, created_at FROM events;
      DROP TABLE events;
      ALTER TABLE events_rebuilt RENAME TO events;
      CREATE INDEX idx_events_created ON events(created_at);
      CREATE INDEX idx_events_workspace ON events(workspace_id);
      CREATE INDEX idx_events_thread ON events(thread_id);

      CREATE TABLE routing_rules (
        id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'user',
        note TEXT DEFAULT '',
        hit_count INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_routing_keyword ON routing_rules(keyword);
    `,
  },
  {
    version: 4,
    name: 'event-routing-rules',
    up: `
      CREATE TABLE event_routing_rules (
        id TEXT PRIMARY KEY,
        source_pattern TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK (action IN ('route_to_router', 'route_to_worker', 'ignore', 'observe')),
        target_session_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

/** 迁移执行器：按 version 升序应用未执行的迁移，每条独立事务。 */
export function migrateDatabase(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get() as { v: number };
  let current = row.v;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_version(version, name, applied_at) VALUES(?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
      current = migration.version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return current;
}
