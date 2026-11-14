/**
 * plugin_settings 表 Repository：插件运行时设置 KV（如 Router 认领身份）。
 */
import type { DatabaseSync } from 'node:sqlite';

function now(): string {
  return new Date().toISOString();
}

export class PluginSettingRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 读 JSON 值（不存在返回 undefined）。 */
  getJson<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json FROM plugin_settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  /** 写 JSON 值（upsert）。 */
  setJson(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO plugin_settings(key, value_json, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now());
  }

  /** 删除键（存在返回 true）。 */
  remove(key: string): boolean {
    const result = this.db.prepare('DELETE FROM plugin_settings WHERE key = ?').run(key);
    return result.changes > 0;
  }
}
