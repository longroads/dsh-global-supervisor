import { describe, expect, it } from 'vitest';
import { allowedTargets, assertTransition, canTransition, InvalidTransitionError } from '../../src/services/task-state-machine.js';
import type { TaskStatus } from '../../src/types/index.js';

const ALL: TaskStatus[] = ['pending', 'queued', 'running', 'completed', 'blocked', 'need_human', 'failed', 'canceled'];

/** 期望矩阵（DEVELOPMENT_PLAN §5.2 转换表）。 */
const EXPECTED: Record<TaskStatus, TaskStatus[]> = {
  pending: ['queued', 'canceled'],
  queued: ['running', 'canceled'],
  running: ['completed', 'blocked', 'need_human', 'failed'],
  blocked: ['queued', 'canceled'],
  need_human: ['queued', 'canceled'],
  failed: ['queued', 'canceled'],
  completed: [],
  canceled: [],
};

describe('任务状态机全矩阵', () => {
  it('8×8 全组合与期望矩阵一致', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it('allowedTargets 与期望矩阵一致', () => {
    for (const from of ALL) {
      expect([...allowedTargets(from)].sort()).toEqual([...EXPECTED[from]].sort());
    }
  });

  it('终态不可转出', () => {
    expect(allowedTargets('completed')).toEqual([]);
    expect(allowedTargets('canceled')).toEqual([]);
  });

  it('自转换一律非法', () => {
    for (const status of ALL) {
      expect(canTransition(status, status), `${status} → ${status}`).toBe(false);
    }
  });

  it('assertTransition 非法时抛出携带 from/to 的错误', () => {
    expect(() => assertTransition('completed', 'queued')).toThrow(InvalidTransitionError);
    try {
      assertTransition('completed', 'queued');
      expect.unreachable('应已抛出');
    } catch (error) {
      const e = error as InvalidTransitionError;
      expect(e.from).toBe('completed');
      expect(e.to).toBe('queued');
    }
    expect(() => assertTransition('running', 'completed')).not.toThrow();
  });
});
