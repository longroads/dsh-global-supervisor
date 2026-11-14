# dsh-global-supervisor

DSH（DeepSeek Harness）全局监督插件：跨 Workspace 的项目管理、任务分派、状态监控、定时巡检与事件响应。

在不修改 DSH 核心源码的前提下，以一个 Router 会话统一管理多个项目 Workspace——识别项目、分派任务、恢复 Session、接收结构化汇报、定时巡检，全局状态 SQLite 持久化，Host 重启后可恢复。

## 核心特性

- **Router/Worker 分工**：Router 会话持有 `supervisor_*` 工具集统一调度；Worker 会话经 `worker_report` 结构化汇报（权限服务端校验，非 Prompt 约束）。
- **任务状态机**：`pending → queued → running → completed` 及 `blocked / need_human / failed / canceled`，严格转换表 + 审计留痕；Task 与 TaskRun 分离，重试不覆盖历史。
- **SQLite 持久化**：八张表（projects / tasks / task_runs / task_dependencies / events / worker_reports / schedule_bindings / audit_logs），基于 Node 内建 `node:sqlite`，零原生依赖。
- **事件驱动**：统一事件入口，`event_id` 唯一约束去重（Schedule 非恰好一次投递的兜底）。
- **串行派发**：ModelQueue 默认并发 1，优先级插队不抢占运行中任务，适配本地推理资源。
- **定时巡检**：复用 DSH 原生 Host-wide Schedule（0.2.2-rc.x），不自研 Cron。

## 环境要求

- DSH Desktop **0.2.2-rc.x**（Host-wide Schedule 依赖 0.2.x；0.1.x 不兼容）
- Node ≥ 22.19（内建 `node:sqlite`）

## 安装（开发期 link 模式）

```powershell
# 在 DSH profile 目录（~/.dsh/profiles/desktop）
pnpm add "dsh-global-supervisor@link:<本仓库路径>"
# profile package.json 的 dsh.profile.bundles 加入 "dsh-global-supervisor"
# 重启 DSH Desktop 生效
```

## 开发

```powershell
# 构建与测试须用 DSH runtime node（本机 PATH node 过旧）
node24 node_modules\typescript\bin\tsc -p tsconfig.json   # host 侧构建（含类型检查）
node24 scripts\build-client.mjs                        # client 侧构建（设置面板 bundle）
node24 node_modules\vitest\vitest.mjs run              # 全部测试
```

详见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)（使用说明）、[docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)（开发方案）、[docs/API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md)（API 使用契约，10/10 VERIFIED + 宿主沙箱契约）、[docs/TEST_PLAN.md](docs/TEST_PLAN.md)（测试与验收映射）、[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)（部署运维）、[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)（排障）、[AGENTS.md](AGENTS.md)（工程纪律）。

## 状态

当前版本 0.1.0-alpha.1：**S1-S6 第一阶段全部完成**——API 探针（真实 Host 10/10 VERIFIED）、工程骨架、八表数据模型、核心服务（TaskManager/ModelQueue/EventManager/看门狗/通知器）、Adapter 四件套、15 个工具（三段式权限防线）。已在真实 Desktop Host 装载验证（服务栈 + 工具注册 + SQLite 建库）；73/73 单测全绿。剩余会话级闭环验证与 S7（IM 推送/外部事件源/主动发现）见 TEST_PLAN 验收映射。

## License

MIT
