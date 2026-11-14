# AGENTS.md — dsh-global-supervisor 开发规范

## 项目

DSH（DeepSeek Harness）全局监督插件：跨 Workspace 的项目管理、任务分派、状态监控、定时巡检与事件响应。方案见 `docs/DEVELOPMENT_PLAN.md`（本文件是其工程纪律的执行细则）。

## 环境（关键约束）

- 目标宿主：DSH Desktop **0.2.2-rc.x** Host 进程（Node 24.21.0）。旧版 API（0.1.x）与本插件不兼容，禁止参考本机旧资料。
- 本机 PATH 的 node 是 v16（仅用于 npm install）；**构建与测试必须用 runtime node**：
  `C:\Users\zyc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- API 使用铁律：只允许调用 `docs/API_COMPATIBILITY.md` 中标记 **VERIFIED** 的接口；TYPE_ONLY 需先经 probe 复核。禁止凭类型声明推断运行时行为。

## 常用命令（node24 指代上述 node.exe 路径）

```
node24 node_modules\typescript\bin\tsc -p tsconfig.json      # 构建 host 侧（同时是类型检查）
node24 scripts\build-client.mjs                              # 构建 client 侧（设置面板 bundle）
node24 node_modules\vitest\vitest.mjs run                     # 全部测试
node24 scripts\smoke-client.cjs                              # client bundle 本地冒烟（factory/注册链路）
```

## 提交前必须

1. tsc 零错误；
2. vitest 全绿；
3. 新增 DSH API 调用已收录于 API_COMPATIBILITY.md 并有状态标记。

## 代码纪律

- 2 空格缩进；变量 camelCase；函数动词开头；注释一律中文。
- 禁止 `as any` / `@ts-ignore` / `@ts-expect-error`；类型不确定就显式收窄。
- 所有 DSH API 调用收敛在 `src/adapters/`，业务服务禁止直接 import DSH 内部包（类型 import 除外）。
- 所有 SQL 收敛在 `src/database/repository/`，服务层禁止手写 SQL 字符串。
- Worker 永远不直接写任务状态：只经 `worker_report` → TaskManager 状态机。
- 错误处理：关键操作必须 try/catch + 日志 + 可恢复状态；禁止吞错。
- 测试与实现同 commit 提交；测试不得 pin 文案，只测机器消费值（状态转换、ID、计数、协议字段）。

## 宿主沙箱契约（详见 docs/API_COMPATIBILITY.md，违者插件加载失败或服务不可见）

- 服务访问一律 `ctx.get('serviceName')`；**禁止属性访问**（inject 声明制门禁，名字错误会导致插件永不加载）。
- 模块顶层**零 `node:*` 静态依赖**；内建模块（node:sqlite / node:fs / node:os / node:path）在使用点动态 `await import()`。
- workspaceRegistry 与 schedule 就绪晚于 apply 时刻：Adapter 必须等待式解析（参照 probe 的 `awaitService`）。
- 工具注册经 `ctx.get('tools').register(definition, options?)`；ctx 只读，façade 白名单动词之外的一切不可用。
- **client 侧同款门禁**：client 入口须 `export const inject = ['slots']` 之类声明，否则 `ctx.slots` 访问抛错、面板不注册。
- **client bundle 格式**：`window.__ModuleLoader__.load({ id, factory })` + CJS 体（`scripts/build-client.mjs` 生成，`scripts/smoke-client.cjs` 本地冒烟）。

## 目录职责

```
src/adapters/     DSH API 唯一触达点（版本差异隔离层）
src/services/     业务服务（WorkspaceManager/AgentController/TaskManager/…）
src/database/     连接、迁移、Repository
src/tools/        supervisor_* / worker_report 工具（含权限三道防线）
src/protocols/    Worker 汇报协议、事件协议（zod 式严格校验）
src/types/        公共类型
tests/unit/       纯逻辑单测（:memory: SQLite）
tests/integration/ 真实 cordis 上下文冒烟（依赖 VERIFIED 结论）
tests/recovery/   重启/重复触发恢复场景
```

## Git 规范

- semantic 前缀 + 中文描述：`feat:` / `fix:` / `docs:` / `test:` / `chore:` / `refactor:`。
- 原子提交：一个提交一个可独立回滚的增量；3+ 文件必须拆分（按模块/关注点）。
- 不提交：node_modules/、dist/、*.db、.env、运行日志。
