import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_LEN, LIST_ITEM_MAX_LEN, parseWorkerReport, ReportValidationError, SUMMARY_MAX_LEN, targetStatusOf } from '../../src/protocols/worker-report.js';

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

  it('FB-14：文本字段入库前清洗控制字符与孤立代理项，保留 \\t\\n\\r', () => {
    const report = parseWorkerReport({
      workspace_id: 'ws-1',
      task_id: 'task-001',
      status: 'running',
      summary: '首行\x1b[31m带ANSI\x1b[0m\n第二行\t缩进\r回车\x00尾\x07',
      blockers: ['障碍\x0B含垂直制表'],
      suggested_actions: ['建议\ud800含孤立代理'],
      evidence: '证据\udfff低位代理结尾',
    });
    expect(report.summary).toBe('首行带ANSI\n第二行\t缩进\r回车尾');
    expect(report.blockers).toEqual(['障碍含垂直制表']);
    expect(report.suggestedActions).toEqual(['建议\uFFFD含孤立代理']);
    expect(report.evidence).toBe('证据\uFFFD低位代理结尾');
  });

  it('FB-14：超长文本按字段上限截断而非拒绝', () => {
    const report = parseWorkerReport({
      workspace_id: 'ws-1',
      task_id: 'task-001',
      status: 'running',
      summary: 'x'.repeat(SUMMARY_MAX_LEN + 500),
      blockers: ['y'.repeat(LIST_ITEM_MAX_LEN + 100)],
      evidence: 'z'.repeat(EVIDENCE_MAX_LEN + 50),
    });
    expect(report.summary?.length).toBe(SUMMARY_MAX_LEN + '…[truncated]'.length);
    expect(report.summary?.endsWith('…[truncated]')).toBe(true);
    expect(report.blockers[0]?.length).toBe(LIST_ITEM_MAX_LEN + '…[truncated]'.length);
    expect(report.evidence?.length).toBe(EVIDENCE_MAX_LEN + '…[truncated]'.length);
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
