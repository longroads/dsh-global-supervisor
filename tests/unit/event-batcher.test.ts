import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBatcher } from '../../src/services/event-batcher.js';
import type { EventRow } from '../../src/types/index.js';

const ROUTER = 'session-router';

function ev(id: string): EventRow {
  return { id: 1, event_id: id, source: 'webhook', type: 'issue.opened', workspace_id: null, task_id: null, payload_json: `{"body":"${id}"}`, dedup_hash: null, thread_id: null, channel_ref: null, actor_json: null, human: 0, created_at: new Date().toISOString() };
}

interface Call {
  sessionId: string;
  text: string;
}

function spyTarget(busy = () => false) {
  const calls: Call[] = [];
  return {
    calls,
    target: {
      dispatch: async (sessionId: string, text: string) => { calls.push({ sessionId, text }); },
      isBusy: async (sessionId: string) => busy(),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EventBatcher 合批投递', () => {
  it('防抖窗口内多条事件合批为一条 Router followup（验收 6.3-1）', async () => {
    vi.useFakeTimers();
    const { calls, target } = spyTarget();
    const batcher = new EventBatcher(target, () => ROUTER, { debounceMs: 500 });
    for (let i = 1; i <= 5; i++) batcher.add(ev(`wh-${i}`));
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(ROUTER);
    for (let i = 1; i <= 5; i++) expect(calls[0]?.text).toContain(`wh-${i}`);
    expect(batcher.pendingCount()).toBe(0);
  });

  it('满 maxBatch 立即合批（不等防抖窗口）', async () => {
    vi.useFakeTimers();
    const { calls, target } = spyTarget();
    const batcher = new EventBatcher(target, () => ROUTER, { debounceMs: 500, maxBatch: 3 });
    batcher.add(ev('wh-1'));
    batcher.add(ev('wh-2'));
    expect(calls).toHaveLength(0);
    batcher.add(ev('wh-3'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('共 3 条');
  });

  it('Router 忙时延后：忙则不投递，空闲后防抖重试', async () => {
    vi.useFakeTimers();
    let busy = true;
    const { calls, target } = spyTarget(() => busy);
    const batcher = new EventBatcher(target, () => ROUTER, { debounceMs: 100 });
    batcher.add(ev('wh-1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);
    expect(batcher.pendingCount()).toBe(1);
    busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
  });

  it('派发失败回填重试并触发 onError（at-least-once）', async () => {
    vi.useFakeTimers();
    const errors: Array<{ batchSize: number; message: string }> = [];
    let fail = true;
    const calls: Call[] = [];
    const target = {
      dispatch: async (sessionId: string, text: string) => {
        if (fail) throw new Error('dispatch 失败');
        calls.push({ sessionId, text });
      },
    };
    const batcher = new EventBatcher(target, () => ROUTER, { debounceMs: 100 }, (error, batchSize) => {
      errors.push({ batchSize, message: error instanceof Error ? error.message : String(error) });
    });
    batcher.add(ev('wh-1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.batchSize).toBe(1);
    expect(errors[0]?.message).toContain('dispatch 失败');
    expect(batcher.pendingCount()).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(batcher.pendingCount()).toBe(0);
  });

  it('渲染带字符预算截断与召回提示', async () => {
    vi.useFakeTimers();
    const { calls, target } = spyTarget();
    const batcher = new EventBatcher(target, () => ROUTER, { debounceMs: 100, maxChars: 120 });
    batcher.add(ev('wh-a'));
    batcher.add(ev('wh-b'));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('wh-a');
    expect(calls[0]?.text).toContain('超出字符预算');
    expect(calls[0]?.text).toContain('supervisor_recall');
  });
});
