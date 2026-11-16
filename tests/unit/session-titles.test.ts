import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { DshSessionAdapter } from '../../src/adapters/dsh-session.js';

let projcacheDir: string;

beforeEach(() => {
  projcacheDir = mkdtempSync(join(tmpdir(), 'projcache-test-'));
});

afterEach(() => {
  rmSync(projcacheDir, { recursive: true, force: true });
});

function writeProjcache(sessionId: string, title: unknown): void {
  writeFileSync(join(projcacheDir, `${sessionId}.json`), JSON.stringify({ record: { rows: { title: { val: title } } } }), 'utf8');
}

/** projcache 目录注入的适配器（fake ctx：无任何服务，readTitles 恒空）。 */
function adapter(): DshSessionAdapter {
  const fakeCtx = { get: () => undefined } as unknown as Context;
  return new DshSessionAdapter(fakeCtx, projcacheDir);
}

describe('DshSessionAdapter projcache 标题读取', () => {
  it('读取 record.rows.title.val；畸形 JSON / 缺 title / 缺文件静默跳过', async () => {
    writeProjcache('session-a', '切换cloud2bim会话模型为GLM-5.3');
    writeProjcache('session-b', '  JumpServer 登录表单选择器配置咨询  ');
    writeFileSync(join(projcacheDir, 'session-c.json'), 'not-json{', 'utf8');
    writeProjcache('session-d', 123);
    const titles = await adapter().readCachedTitles(['session-a', 'session-b', 'session-c', 'session-d', 'session-e']);
    expect(titles.size).toBe(2);
    expect(titles.get('session-a')).toBe('切换cloud2bim会话模型为GLM-5.3');
    expect(titles.get('session-b')).toBe('JumpServer 登录表单选择器配置咨询');
  });

  it('目录不存在返回空 Map 不抛错；空入参短路', async () => {
    const missing = new DshSessionAdapter({ get: () => undefined } as unknown as Context, join(projcacheDir, 'no-such-dir'));
    expect((await missing.readCachedTitles(['session-a'])).size).toBe(0);
    expect((await adapter().readCachedTitles([])).size).toBe(0);
  });
});
