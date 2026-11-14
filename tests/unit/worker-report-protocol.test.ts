import { describe, expect, it } from 'vitest';
import { parseWorkerReport, ReportValidationError, targetStatusOf } from '../../src/protocols/worker-report.js';

describe('Worker 汇报协议校验', () => {
  it('合法载荷完整通过并归一化默认值', () => {
    const report = parseWorkerReport({
      workspace_id: 'ws-1',
      task_id: 'task-001',
      status: 'running',
      progress: 65,
    });
    expect(report.workspaceId).toBe('ws-1');
    expect(report.taskId).toBe('task-001');
    expect(report.status).toBe('running');
    expect(report.progress).toBe(65);
    expect(report.blockers).toEqual([]);
    expect(report.needHuman).toBe(false);
    expect(report.suggestedActions).toEqual([]);
  });

  it('未知字段被拒绝并列出问题清单', () => {
    expect(() => parseWorkerReport({ workspace_id: 'w', task_id: 't', status: 'running', extra: 1, another: 'x' }))
      .toThrow(ReportValidationError);
    try {
      parseWorkerReport({ workspace_id: 'w', task_id: 't', status: 'running', extra: 1 });
      expect.unreachable('应已抛出');
    } catch (error) {
      const issues = (error as ReportValidationError).issues;
      expect(issues.some((i) => i.includes('extra'))).toBe(true);
    }
  });

  it.each([
    ['status 越界', { workspace_id: 'w', task_id: 't', status: 'queued' }],
    ['progress 越上界', { workspace_id: 'w', task_id: 't', status: 'running', progress: 101 }],
    ['progress 非整数', { workspace_id: 'w', task_id: 't', status: 'running', progress: 65.5 }],
    ['need_human 非布尔', { workspace_id: 'w', task_id: 't', status: 'running', need_human: 'yes' }],
    ['blockers 非字符串数组', { workspace_id: 'w', task_id: 't', status: 'running', blockers: [1, 2] }],
    ['workspace_id 空', { workspace_id: '  ', task_id: 't', status: 'running' }],
    ['task_id 缺失', { workspace_id: 'w', status: 'running' }],
    ['载荷非对象', 'not-an-object'],
  ])('%s 被拒绝', (_label, payload) => {
    expect(() => parseWorkerReport(payload)).toThrow(ReportValidationError);
  });

  it('汇报状态到任务状态映射符合契约（running 仅心跳）', () => {
    expect(targetStatusOf('running')).toBeNull();
    expect(targetStatusOf('completed')).toBe('completed');
    expect(targetStatusOf('blocked')).toBe('blocked');
    expect(targetStatusOf('need_human')).toBe('need_human');
    expect(targetStatusOf('failed')).toBe('failed');
  });
});
