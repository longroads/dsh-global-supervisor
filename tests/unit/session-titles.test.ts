import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** 计数版 fake ctx：记录每个服务名被解析的次数。 */
function fakeCtx(services: Record<string, unknown>, counts: Record<string, number>): Context {
  return {
    get: (name: string) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return services[name];
    },
  } as unknown as Context;
}

describe('DshSessionAdapter 标题能力探测（0.5.6 修复：禁止盲调未 VERIFIED 接口）', () => {
  it('sessionQuery 无 readTitleSnapshots（本宿主实况）：空 Map 不抛错、只解析一次、诊断只记一行', async () => {
    const counts: Record<string, number> = {};
    const lines: string[] = [];
    const a = new DshSessionAdapter(
      fakeCtx({ sessionQuery: { listSessions: () => undefined } }, counts),
      projcacheDir,
      (line) => lines.push(line),
    );
    expect((await a.readTitles(['s-1'])).size).toBe(0);
    expect((await a.readTitles(['s-1', 's-2'])).size).toBe(0);
    expect(counts['sessionQuery']).toBe(1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('title 能力缺失');
    expect(lines[0]).toContain('无 readTitleSnapshots 方法');
  });

  it('能力可用：读取并 trim 标题、跳过空标题；读取函数保持 this 绑定', async () => {
    const counts: Record<string, number> = {};
    const lines: string[] = [];
    const query = {
      prefix: 'T:',
      readTitleSnapshots(ids: readonly string[]) {
        return Promise.resolve(ids.map((id, index) => ({
          sessionId: id,
          status: 'ok',
          title: index === 0 ? { title: ` ${this.prefix}${id} `, source: 'log' } : undefined,
        })));
      },
    };
    const a = new DshSessionAdapter(fakeCtx({ sessionQuery: query }, counts), projcacheDir, (line) => lines.push(line));
    const titles = await a.readTitles(['s-1', 's-2']);
    expect(titles.get('s-1')).toBe('T:s-1');
    expect(titles.has('s-2')).toBe(false);
    expect(lines.some((line) => line.includes('ok:1/2'))).toBe(true);
  });

  it('sessionQuery 永不就绪：判为能力缺失返回空 Map，结论缓存后不再重复等待', async () => {
    vi.useFakeTimers();
    try {
      const counts: Record<string, number> = {};
      const lines: string[] = [];
      const a = new DshSessionAdapter(fakeCtx({}, counts), projcacheDir, (line) => lines.push(line));
      const first = a.readTitles(['s-1']);
      await vi.advanceTimersByTimeAsync(11_000);
      expect((await first).size).toBe(0);
      expect(counts['sessionQuery']).toBe(50);
      const afterFirst = counts['sessionQuery'];
      expect((await a.readTitles(['s-1', 's-2'])).size).toBe(0);
      expect(counts['sessionQuery']).toBe(afterFirst);
      expect(lines.filter((line) => line.includes('title 能力缺失')).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('读取调用期抛错：空 Map 不抛错，诊断记 error 原因', async () => {
    const lines: string[] = [];
    const query = { readTitleSnapshots: () => Promise.reject(new Error('boom')) };
    const a = new DshSessionAdapter(fakeCtx({ sessionQuery: query }, {}), projcacheDir, (line) => lines.push(line));
    expect((await a.readTitles(['s-1'])).size).toBe(0);
    expect(lines.some((line) => line.includes('error:boom'))).toBe(true);
  });
});
