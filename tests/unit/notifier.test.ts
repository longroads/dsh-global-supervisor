import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { DshImNotifierAdapter } from '../../src/adapters/dsh-im-notifier.js';
import { NotifierService } from '../../src/services/notifier.js';

interface SendCall {
  botId: string;
  targetId: string;
  text: string;
}

function fakeCtx(service: unknown): Context {
  return { get: (name: string) => (name === 'dshIm' ? service : undefined) } as unknown as Context;
}

describe('DshImNotifierAdapter 主动投递', () => {
  it('dsh-im 未安装：返回 false 不抛错（由上层降级到会话）', async () => {
    const adapter = new DshImNotifierAdapter(fakeCtx(undefined));
    expect(await adapter.notify('消息', { botId: 'bot-1', targetId: 't-1' })).toBe(false);
  });

  it('send 返回 sent:true → 投递成功且参数原样透传', async () => {
    const calls: SendCall[] = [];
    const service = {
      send: async (botId: string, targetId: string, text: string) => {
        calls.push({ botId, targetId, text });
        return { sent: true };
      },
    };
    const adapter = new DshImNotifierAdapter(fakeCtx(service));
    expect(await adapter.notify('巡检完成', { botId: 'bot-1', targetId: 't-1' })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.botId).toBe('bot-1');
    expect(calls[0]?.targetId).toBe('t-1');
    expect(calls[0]?.text).toBe('巡检完成');
  });

  it('send 返回 sent:false → 投递失败（false）', async () => {
    const adapter = new DshImNotifierAdapter(fakeCtx({ send: async () => ({ sent: false }) }));
    expect(await adapter.notify('消息', { botId: 'b', targetId: 't' })).toBe(false);
  });

  it('send 抛错（Bot 离线）→ 投递失败（false，不抛给调用方）', async () => {
    const adapter = new DshImNotifierAdapter(fakeCtx({ send: async () => { throw new Error('bot 离线'); } }));
    expect(await adapter.notify('消息', { botId: 'b', targetId: 't' })).toBe(false);
  });

  it('botId 或 targetId 缺失 → 不调用服务直接 false', async () => {
    let called = 0;
    const service = { send: async () => { called++; return { sent: true }; } };
    const adapter = new DshImNotifierAdapter(fakeCtx(service));
    expect(await adapter.notify('消息', { botId: '', targetId: 't' })).toBe(false);
    expect(await adapter.notify('消息', { botId: 'b', targetId: '  ' })).toBe(false);
    expect(called).toBe(0);
  });
});

describe('NotifierService 通知路由层', () => {
  it("type='session'：只走 Router 会话，不触碰 IM", async () => {
    const session: string[] = [];
    const im: string[] = [];
    const service = new NotifierService(
      { notify: async (message) => { session.push(message); return true; } },
      { notify: async (message) => { im.push(message); return true; } },
      { type: 'session', botId: 'bot-1', targetId: 't-1' },
    );
    expect(await service.notify('消息')).toBe(true);
    expect(session).toHaveLength(1);
    expect(im).toHaveLength(0);
  });

  it("type='dsh-im' 且 IM 成功：走 IM 不降级", async () => {
    const session: string[] = [];
    const im: string[] = [];
    const service = new NotifierService(
      { notify: async (message) => { session.push(message); return true; } },
      { notify: async (message) => { im.push(message); return true; } },
      { type: 'dsh-im', botId: 'bot-1', targetId: 't-1' },
    );
    expect(await service.notify('消息')).toBe(true);
    expect(im).toHaveLength(1);
    expect(session).toHaveLength(0);
  });

  it("type='dsh-im' 但 IM 失败（Bot 离线）：降级到 Router 会话", async () => {
    const session: string[] = [];
    const service = new NotifierService(
      { notify: async (message) => { session.push(message); return true; } },
      { notify: async () => false },
      { type: 'dsh-im', botId: 'bot-1', targetId: 't-1' },
    );
    expect(await service.notify('消息')).toBe(true);
    expect(session).toHaveLength(1);
  });

  it("type='dsh-im' 但 botId 未配置：直接走 Router 会话", async () => {
    const session: string[] = [];
    const im: string[] = [];
    const service = new NotifierService(
      { notify: async (message) => { session.push(message); return true; } },
      { notify: async (message) => { im.push(message); return true; } },
      { type: 'dsh-im', botId: '', targetId: 't-1' },
    );
    expect(await service.notify('消息')).toBe(true);
    expect(im).toHaveLength(0);
    expect(session).toHaveLength(1);
  });

  it('严重级别前缀单次施加（info/warning/critical）', async () => {
    const seen: string[] = [];
    const service = new NotifierService(
      { notify: async (message) => { seen.push(message); return true; } },
      { notify: async () => false },
      { type: 'session', botId: '', targetId: '' },
    );
    await service.notify('a', 'info');
    await service.notify('b', 'warning');
    await service.notify('c', 'critical');
    expect(seen[0]).toBe('【通知】 a');
    expect(seen[1]).toBe('【警告】 b');
    expect(seen[2]).toBe('【严重】 c');
  });
});

describe('NotifierService IM 退避重试（Phase 6 6-C）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warning IM 失败：即时降级会话 + 60s 后补发一次成功即止', async () => {
    vi.useFakeTimers();
    const session: string[] = [];
    let imFail = true;
    let imCalls = 0;
    const service = new NotifierService(
      { notify: async (message) => { session.push(message); return true; } },
      {
        notify: async (message: string) => {
          imCalls += 1;
          if (imFail) throw new Error('bot 离线');
          session.push(`im:${message}`);
          return true;
        },
      },
      { type: 'dsh-im', botId: 'bot-1', targetId: 't-1' },
    );
    expect(await service.notify('升级', 'warning')).toBe(true);
    expect(session).toHaveLength(1);
    expect(service.pendingRetries()).toBe(1);
    imFail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(imCalls).toBe(2);
    expect(service.pendingRetries()).toBe(0);
    expect(session.some((m) => m.startsWith('im:'))).toBe(true);
    service.stop();
  });

  it('info IM 失败不重试；持续失败重试耗尽后出队', async () => {
    vi.useFakeTimers();
    const session: string[] = [];
    let imCalls = 0;
    const service = new NotifierService(
      { notify: async (message) => { session.push(message); return true; } },
      {
        notify: async () => {
          imCalls += 1;
          return false;
        },
      },
      { type: 'dsh-im', botId: 'bot-1', targetId: 't-1' },
    );
    await service.notify('轻通知', 'info');
    expect(service.pendingRetries()).toBe(0);

    expect(await service.notify('升级', 'critical')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(imCalls).toBe(3);
    expect(service.pendingRetries()).toBe(0);
    service.stop();
  });
});
