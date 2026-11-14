/**
 * SQLite 连接管理：打开数据库、设置 PRAGMA、提供事务助手。
 * 唯一允许创建 DatabaseSync 的位置（Repository 通过构造注入使用）。
 * 沙箱纪律：顶层零 node:* 静态依赖——内建模块在使用点动态 import。
 */
import type { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './migrations.js';

/** 打开数据库并应用全部迁移。
 * @param dbPath - 数据库文件路径；`:memory:` 用于单元测试
 * @returns 已迁移至最新版本的连接
 */
export async function openDatabase(dbPath: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite');
  if (dbPath !== ':memory:') {
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  migrateDatabase(db);
  return db;
}

/** 在单个 IMMEDIATE 事务中执行写组：任一抛错即整体回滚。
 * @param db - 数据库连接
 * @param fn - 事务体（同步；node:sqlite 为同步 API）
 * @returns fn 的返回值
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
