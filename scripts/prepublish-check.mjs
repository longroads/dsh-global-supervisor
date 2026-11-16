// 发布门禁脚本：npm prepublishOnly 入口。
// npm 生命周期脚本用的是 PATH 里的 node（本机为 v16，跑不动 vitest/tsc 新版），
// 这里定位 DSH runtime node（AGENTS.md 规定构建与测试必须用它）后逐项执行门禁。
// 任一门禁失败即中止发布（npm publish 收到非零退出码会终止）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// 定位 DSH runtime node：环境变量优先，其次默认安装路径
function resolveRuntimeNode() {
  const rel = path.join(
    '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const candidates = process.env.DSH_RUNTIME_NODE
    ? [process.env.DSH_RUNTIME_NODE]
    : [path.join(os.homedir(), rel)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `未找到 DSH runtime node（尝试过: ${candidates.join(', ')}）。` +
    '请设置 DSH_RUNTIME_NODE 环境变量指向 runtime node 可执行文件。',
  );
}

const nodeBin = resolveRuntimeNode();
console.log(`[prepublish] 使用 runtime node: ${nodeBin}`);

// 门禁序列：类型检查+host 构建 → client 构建 → 全量测试 → client bundle 冒烟
const gates = [
  { name: 'tsc 类型检查与 host 构建', args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'] },
  { name: 'client bundle 构建', args: ['scripts/build-client.mjs'] },
  { name: 'vitest 全量测试', args: ['node_modules/vitest/vitest.mjs', 'run'] },
  { name: 'client bundle 冒烟', args: ['scripts/smoke-client.cjs'] },
];

for (const gate of gates) {
  console.log(`[prepublish] ▶ ${gate.name}`);
  const result = spawnSync(nodeBin, gate.args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[prepublish] ✗ ${gate.name} 失败（退出码 ${result.status}），发布中止。`);
    process.exit(result.status ?? 1);
  }
  console.log(`[prepublish] ✓ ${gate.name}`);
}
console.log('[prepublish] 全部门禁通过，可以发布。');
