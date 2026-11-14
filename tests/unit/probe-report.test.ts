/**
 * 探针报告结构的单元测试（纯数据结构，不依赖 Host）。
 */
import { describe, expect, it } from 'vitest';
import type { ProbeCheck, ProbeReport, ProbeStatus } from '../../src/types/index.js';

describe('ProbeReport 数据结构', () => {
  it('ProbeCheck 四态状态与耗时可完整表达', () => {
    const statuses: ProbeStatus[] = ['VERIFIED', 'UNAVAILABLE', 'UNSTABLE', 'SKIPPED'];
    const checks: ProbeCheck[] = statuses.map((status, index) => ({
      id: `check-${index}`,
      name: `检查 ${index}`,
      status,
      detail: '证据',
      durationMs: index,
    }));
    expect(checks).toHaveLength(4);
    expect(new Set(checks.map((c) => c.status))).toEqual(new Set(statuses));
  });

  it('ProbeReport 必备字段齐备', () => {
    const report: ProbeReport = {
      ranAt: new Date().toISOString(),
      nodeVersion: 'v24.21.0',
      pluginVersion: '0.1.0-alpha.1',
      dataDir: '/tmp/global-supervisor',
      checks: [],
    };
    expect(report.checks).toEqual([]);
    expect(report.nodeVersion).toMatch(/^v\d+\./);
  });
});
