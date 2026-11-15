import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/connection.js';
import { RoutingRuleRepository } from '../../src/database/repository/routing-rule-repository.js';

async function setup(): Promise<{ repo: RoutingRuleRepository; db: Awaited<ReturnType<typeof openDatabase>> }> {
  const db = await openDatabase(':memory:');
  return { repo: new RoutingRuleRepository(db), db };
}

describe('RoutingRuleRepository 路由偏好', () => {
  it('保存后按关键词命中（大小写不敏感），无关文本不命中', async () => {
    const { repo, db } = await setup();
    await repo.save({ keyword: 'Kubernetes', workspaceId: 'ws-research', note: 'k8s 都给 research' });
    expect(repo.lookup('帮我看看 KUBERNETES 新版本')).toHaveLength(1);
    expect(repo.lookup('写一个前端页面')).toHaveLength(0);
    db.close();
  });

  it('同关键词重复保存覆盖目标工作区且命中数保留', async () => {
    const { repo, db } = await setup();
    await repo.save({ keyword: 'k8s', workspaceId: 'ws-a' });
    repo.lookupAndRecord('k8s 任务一');
    repo.lookupAndRecord('k8s 任务二');
    const updated = await repo.save({ keyword: 'k8s', workspaceId: 'ws-b' });
    expect(updated.workspace_id).toBe('ws-b');
    expect(updated.hit_count).toBe(2);
    expect(repo.list()).toHaveLength(1);
    db.close();
  });

  it('lookupAndRecord 返回的行 hit_count 已递增且多规则按命中数降序', async () => {
    const { repo, db } = await setup();
    await repo.save({ keyword: '前端', workspaceId: 'ws-fe' });
    await repo.save({ keyword: '后端', workspaceId: 'ws-be' });
    repo.lookupAndRecord('前端页面'); // fe → 1
    repo.lookupAndRecord('后端接口'); // be → 1
    repo.lookupAndRecord('前端组件'); // fe → 2
    const hits = repo.lookupAndRecord('前端与后端一起做');
    expect(hits.map((r) => r.keyword)).toEqual(['前端', '后端']);
    expect(hits[0]?.hit_count).toBe(3);
    expect(hits[1]?.hit_count).toBe(2);
    db.close();
  });

  it('disable 后规则不再命中，list 仍可见', async () => {
    const { repo, db } = await setup();
    const rule = await repo.save({ keyword: 'ci', workspaceId: 'ws-ops' });
    expect(repo.disable(rule.id)).toBe(true);
    expect(repo.lookup('跑一下 ci')).toHaveLength(0);
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.enabled).toBe(0);
    db.close();
  });
});
