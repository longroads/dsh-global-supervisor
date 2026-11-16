import { describe, expect, it } from 'vitest';
import { UpdateChecker, compareVersions } from '../../src/services/update-checker.js';
import { PLUGIN_VERSION } from '../../src/version.js';

const okJson = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** 按调用次序取第 n 个 handler（超出取最后一个），记录全部请求 URL。 */
function fakeFetch(handlers: Array<(url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = ((input: unknown) => {
    const url = String(input);
    urls.push(url);
    const handler = handlers[Math.min(urls.length - 1, handlers.length - 1)];
    return handler(url);
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('compareVersions', () => {
  it('数字分段比较：0.5.4<0.5.10、相等=0、1.0.0>0.9.9、缺段按 0', () => {
    expect(compareVersions('0.5.4', '0.5.10')).toBe(-1);
    expect(compareVersions('0.5.4', '0.5.4')).toBe(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.5', '0.5.0')).toBe(0);
  });
});

describe('UpdateChecker', () => {
  it('主源 npmjs 成功：latest/updateAvailable/source=npm，仅一次请求', async () => {
    const { impl, urls } = fakeFetch([() => okJson({ version: '99.9.9' })]);
    const checker = new UpdateChecker({ fetchImpl: impl });
    const state = await checker.refresh();
    expect(state.latest).toBe('99.9.9');
    expect(state.updateAvailable).toBe(true);
    expect(state.source).toBe('npm');
    expect(state.error).toBeNull();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('registry.npmjs.org/dsh-global-supervisor/latest');
  });

  it('主源非 2xx 自动走 npmmirror 兜底；已是最新时 updateAvailable=false', async () => {
    const { impl, urls } = fakeFetch([
      () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
      () => okJson({ version: PLUGIN_VERSION }),
    ]);
    const checker = new UpdateChecker({ fetchImpl: impl });
    const state = await checker.refresh();
    expect(state.source).toBe('npmmirror');
    expect(state.latest).toBe(PLUGIN_VERSION);
    expect(state.updateAvailable).toBe(false);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('npmmirror.com');
  });

  it('两源均不可达：error 记录、latest 保持 null、checkedAt 仍刷新', async () => {
    const { impl } = fakeFetch([() => Promise.reject(new Error('offline'))]);
    const checker = new UpdateChecker({ fetchImpl: impl });
    const state = await checker.refresh();
    expect(state.latest).toBeNull();
    expect(state.updateAvailable).toBe(false);
    expect(state.error).toBe('offline');
    expect(state.checkedAt).not.toBeNull();
  });

  it('enabled=false：refresh 返回 disabled 且零网络请求', async () => {
    const { impl, urls } = fakeFetch([() => okJson({ version: '99.9.9' })]);
    const checker = new UpdateChecker({ fetchImpl: impl, enabled: false });
    const state = await checker.refresh();
    expect(state.disabled).toBe(true);
    expect(state.latest).toBeNull();
    expect(urls).toHaveLength(0);
  });

  it('refreshIfStale：首轮刷新后 TTL 内不重复请求', async () => {
    const { impl, urls } = fakeFetch([() => okJson({ version: '99.9.9' })]);
    const checker = new UpdateChecker({ fetchImpl: impl });
    checker.refreshIfStale();
    await new Promise((r) => setTimeout(r, 10));
    checker.refreshIfStale();
    await new Promise((r) => setTimeout(r, 10));
    expect(urls).toHaveLength(1);
    expect(checker.getState().latest).toBe('99.9.9');
  });

  it('并发去重：在途 refresh 期间重复调用共享同一请求', async () => {
    const { impl, urls } = fakeFetch([() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({ version: '1.0.0' }) }), 20);
    })]);
    const checker = new UpdateChecker({ fetchImpl: impl });
    const [a, b] = await Promise.all([checker.refresh(), checker.refresh()]);
    expect(urls).toHaveLength(1);
    expect(a.latest).toBe('1.0.0');
    expect(b).toEqual(a);
  });
});
