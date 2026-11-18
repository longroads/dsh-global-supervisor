import { describe, expect, it } from 'vitest';
import { ModelQueue } from '../../src/services/model-queue.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ModelQueue 并发控制', () => {
  it('并发 1：任务严格串行', async () => {
    const queue = new ModelQueue(1);
    const order: string[] = [];
    const first = queue.submit({ id: 'a', priority: 5 });
    const second = queue.submit({ id: 'b', priority: 5 });
    const h1 = await first;
    order.push('a-start');
    expect(queue.stats()).toEqual({ running: 1, waiting: 1 });
    h1.release();
    const h2 = await second;
    order.push('b-start');
    h2.release();
    expect(order).toEqual(['a-start', 'b-start']);
    expect(queue.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('FB-18 cancel：取消排队项后，许可释放不再放行已取消任务', async () => {
    const queue = new ModelQueue(1);
    const h1 = await queue.submit({ id: 'a', priority: 5 });
    const cancelled = queue.submit({ id: 'b', priority: 5 });
    expect(queue.cancel('b')).toBe(true);
    h1.release();
    await sleep(20);
    // 已取消的 b 不获许可；cancel 返回 false（不在等待中也不持许可）
    expect(queue.stats().running).toBe(0);
    expect(queue.cancel('b')).toBe(false);
    // 迟到的许可由调用方归还（dispatchTask 的 race 分支负责），队列保持排空
    const next = queue.submit({ id: 'c', priority: 5 });
    const h3 = await next;
    expect(h3.held).toBe(true);
    h3.release();
    void cancelled;
  });

  it('高优先级插队：等待中的高优先出队，运行中的不被抢占', async () => {
    const queue = new ModelQueue(1);
    const low = queue.submit({ id: 'low', priority: 1 });
    const high = queue.submit({ id: 'high', priority: 9 });
    const hLow = await low;
    // low 运行中，high 等待；此时再入队中优——不应插到 high 前
    const mid = queue.submit({ id: 'mid', priority: 5 });
    await sleep(10);
    expect(queue.stats()).toEqual({ running: 1, waiting: 2 });
    hLow.release();
    const hHigh = await high;
    expect(queue.stats().running).toBe(1);
    hHigh.release();
    // mid 依序获得许可并释放，队列最终排空
    const hMid = await mid;
    hMid.release();
    const hDrain = await queue.submit({ id: 'drain', priority: 0 });
    hDrain.release();
    expect(queue.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('同级 FIFO', async () => {
    const queue = new ModelQueue(1);
    const handles = ['t1', 't2', 't3'].map((id) => queue.submit({ id, priority: 3 }));
    const grants: string[] = [];
    for (const p of handles) {
      const h = await p;
      grants.push(String(queue.stats().running));
      h.release();
    }
    // 每次只有一个在运行
    expect(grants).toEqual(['1', '1', '1']);
  });

  it('并发 2 允许两个同时运行', async () => {
    const queue = new ModelQueue(2);
    const a = queue.submit({ id: 'a', priority: 1 });
    const b = queue.submit({ id: 'b', priority: 1 });
    const c = queue.submit({ id: 'c', priority: 1 });
    const ha = await a;
    const hb = await b;
    expect(queue.stats()).toEqual({ running: 2, waiting: 1 });
    ha.release();
    const hc = await c;
    expect(queue.stats()).toEqual({ running: 2, waiting: 0 });
    hb.release();
    hc.release();
  });

  it('release 幂等，重复释放不放大许可', async () => {
    const queue = new ModelQueue(1);
    const a = queue.submit({ id: 'a', priority: 1 });
    const b = queue.submit({ id: 'b', priority: 1 });
    const ha = await a;
    ha.release();
    ha.release();
    const hb = await b;
    expect(queue.stats()).toEqual({ running: 1, waiting: 0 });
    hb.release();
  });

  it('非法并发数构造被拒绝', () => {
    expect(() => new ModelQueue(0)).toThrow();
    expect(() => new ModelQueue(1.5)).toThrow();
  });
});
