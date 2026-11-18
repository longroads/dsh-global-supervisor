import { describe, expect, it } from 'vitest';
import { jsonSafeDeep, sanitizeText } from '../../src/utils/json-safe.js';

describe('FB-14 文本清洗 sanitizeText', () => {
  it('去除 C0/C1/DEL 控制字符，保留 \\t \\n \\r', () => {
    expect(sanitizeText('a\x00b\x07c\x1bd\x7Fe\x9Ff\tg\nh\ri')).toBe('abcdef\tg\nh\ri');
    expect(sanitizeText('keep\ttab\nnl\rcr')).toBe('keep\ttab\nnl\rcr');
  });

  it('孤立代理项替换为 U+FFFD，合法代理对（emoji）保留', () => {
    expect(sanitizeText('前\ud800后')).toBe('前\uFFFD后');
    expect(sanitizeText('低\udc00位')).toBe('低\uFFFD位');
    expect(sanitizeText('emoji 🎯 保留')).toBe('emoji 🎯 保留');
  });

  it('超长截断并追加机器可识别标记', () => {
    const out = sanitizeText('x'.repeat(100), 10);
    expect(out.length).toBe(10 + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('maxLen 省略时不截断', () => {
    expect(sanitizeText('x'.repeat(10000)).length).toBe(10000);
  });
});

describe('FB-14 出库侧深度清洗 jsonSafeDeep', () => {
  it('对象/数组/嵌套字符串全部清洗，非字符串原样保留', () => {
    const out = jsonSafeDeep({
      ok: true,
      count: 3,
      nested: { summary: '脏\x1b文本' },
      list: ['\x00item', { inner: 'v' }],
      empty: null,
    });
    expect(out).toEqual({
      ok: true,
      count: 3,
      nested: { summary: '脏文本' },
      list: ['item', { inner: 'v' }],
      empty: null,
    });
  });

  it('历史脏数据（清洗上线前入库）同样被拦截', () => {
    const out = jsonSafeDeep({ latestReport: { summary: 'log: \x1b[31mERR\x1b[0m done' } });
    expect(out.latestReport.summary).toBe('log: ERR done');
  });

  it('超深嵌套原样返回不再递归（防御异常结构）', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: '深\x00层' } } } } } } } } };
    const out = jsonSafeDeep(deep) as typeof deep;
    expect(out.a.b.c.d.e.f.g.h.i).toBe('深\x00层');
  });
});
