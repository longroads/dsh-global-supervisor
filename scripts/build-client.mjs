// client 构建脚本：esbuild 打包 CJS + __ModuleLoader__ factory 包装（契约见 docs/UI_PANEL_PLAN.md）
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'client/client.js');
const banner = readFileSync(resolve(root, 'client/src/factory-banner.txt'), 'utf8').trimEnd();

mkdirSync(dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: [resolve(root, 'client/src/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: ['react', 'react-dom'],
  write: false,
  logLevel: 'info',
});
const code = result.outputFiles[0].text;
// 尾部依次闭合：factory 函数体 } 、load 的对象字面量 } 、load 调用 ) 与 ;
writeFileSync(outfile, `${banner}\n${code}\nreturn module.exports;\n}});\n`, 'utf8');
console.log(`client bundle -> ${outfile} (${code.length} chars)`);
