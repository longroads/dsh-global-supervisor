import { describe, expect, it } from 'vitest';
import { SessionHealth } from '../../src/services/session-health.js';
import type { RunningTaskSource } from '../../src/services/session-health.js';

interface Notice {
  message: string;
  severity: string;
}

function buildHealth(runningTasks: Array<{ id: string; assigned_session_id: string | null }>, threshold = 2): { health: SessionHealth; notices: Notice[] } {
  const notices: Notice[] = [];
  const tasks: RunningTaskSource = { list: () => runningTasks };
  const health = new SessionHealth(
    tasks,
    { notify: async (message, severity) => { notices.push({ message, severity }); return true; } },
    threshold,
  );
  return { health, notices };
}

describe('SessionHealth 会话空转检测（FB-9②③）', () => {
  it('连续无工具调用的 turn 达阈值且会话有 running 任务 → warning 告警（含任务 ID 与处置建议）', async () => {
    const { health, notices } = buildHealth([{ id: 'task-1', assigned_session_id: 'session-w' }]);
    await health.observeTurnEnd('session-w');
    expect(notices).toHaveLength(0);
    await health.observeTurnEnd('session-w');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.severity).toBe('warning');
    expect(notices[0]?.message).toContain('session-w');
    expect(notices[0]?.message).toContain('task-1');
    expect(notices[0]?.message).toContain('supervisor_session_create');
  });

  it('工具调用产出清零计数：穿插 tools/result 不触发告警', async () => {
    const { health, notices } = buildHealth([{ id: 'task-1', assigned_session_id: 'session-w' }]);
    await health.observeTurnEnd('session-w');
    health.observeToolResult('session-w');
    await health.observeTurnEnd('session-w');
    health.observeToolResult('session-w');
    await health.observeTurnEnd('session-w');
    expect(notices).toHaveLength(0);
    // 每次清零后重新计数：末次 turn 后计数为 1（未达阈值）
    expect(health.snapshot()).toEqual([{ sessionId: 'session-w', idleTurns: 1 }]);
  });

  it('会话无 running 任务不告警；告警后去抖（须先出现工具产出才恢复计费）', async () => {
    const running: Array<{ id: string; assigned_session_id: string | null }> = [{ id: 'task-1', assigned_session_id: 'session-w' }];
    const { health, notices } = buildHealth(running);
    // 阈值达到但任务已结束
    running.length = 0;
    await health.observeTurnEnd('session-w');
    await health.observeTurnEnd('session-w');
    expect(notices).toHaveLength(0);
    // 恢复 running 任务后再空转两轮：首轮计费已到阈值 → 告警一次
    running.push({ id: 'task-2', assigned_session_id: 'session-w' });
    await health.observeTurnEnd('session-w');
    expect(notices).toHaveLength(1);
    // 持续空转不再重复告警（去抖）
    await health.observeTurnEnd('session-w');
    await health.observeTurnEnd('session-w');
    expect(notices).toHaveLength(1);
  });
});
