import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { openDatabase } from '../../src/database/connection.js';
import { DshWorkspaceAdapter } from '../../src/adapters/dsh-workspace.js';
import { WorkspaceManager } from '../../src/services/workspace-manager.js';

function fakeCtx(registry: unknown): Context {
  return { get: () => registry } as unknown as Context;
}

function ws(id: string, title: string) {
  return {
    id, path: `E:\\proj\\${title}`, title,
    sessionIds: [`s-${id}`],
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  };
}

describe('WorkspaceManager 全量概览', () => {
  it('未纳管/已纳管/归档混合标注（managed 与占位语义）', async () => {
    const registry = { list: () => [ws('ws-1', 'alpha'), ws('ws-2', 'beta'), ws('ws-3', 'gamma')] };
    const db = await openDatabase(':memory:');
    const manager = new WorkspaceManager(new DshWorkspaceAdapter(fakeCtx(registry)), db);
    manager.projects.create({ id: 'proj-1', workspaceId: 'ws-1', name: 'alpha', priority: 7 });
    manager.projects.create({ id: 'proj-2', workspaceId: 'ws-2', name: 'beta-old' });
    manager.projects.archive('proj-2');

    const overview = await manager.listWorkspaceOverview(true);
    expect(overview).toHaveLength(3);

    const alpha = overview.find((item) => item.workspaceId === 'ws-1');
    expect(alpha?.managed).toBe(true);
    expect(alpha?.projectId).toBe('proj-1');
    expect(alpha?.priority).toBe(7);

    const beta = overview.find((item) => item.workspaceId === 'ws-2');
    expect(beta?.managed).toBe(true);
    expect(beta?.status).toBe('archived');

    // 归档排除时该行降级为未纳管占位（workspace 仍在，项目行被过滤）
    const overviewNoArchived = await manager.listWorkspaceOverview(false);
    const betaNoArchived = overviewNoArchived.find((item) => item.workspaceId === 'ws-2');
    expect(betaNoArchived?.managed).toBe(false);
    expect(betaNoArchived?.status).toBe('unmanaged');

    const gamma = overview.find((item) => item.workspaceId === 'ws-3');
    expect(gamma?.managed).toBe(false);
    expect(gamma?.status).toBe('unmanaged');
    expect(gamma?.sessionCount).toBe(1);
  });
});
