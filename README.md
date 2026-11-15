# dsh-global-supervisor

DSH（DeepSeek Harness）全局监督插件：跨 Workspace 的项目管理、任务分派、状态监控、定时巡检与事件响应。

在不修改 DSH 核心源码的前提下，以一个 Router 会话统一管理多个项目 Workspace——识别项目、分派任务、恢复 Session、接收结构化汇报、定时巡检，全局状态 SQLite 持久化，Host 重启后可恢复。

## 核心特性

- **Router/Worker 分工**：Router 会话持有 `supervisor_*` 工具集（22 个）统一调度；Worker 会话经 `worker_report` 结构化汇报（权限服务端校验，非 Prompt 约束）。
- **任务状态机**：`pending → queued → running → completed` 及 `blocked / need_human / failed / canceled`，严格转换表 + 审计留痕；Task 与 TaskRun 分离，重试不覆盖历史。
- **SQLite 持久化**：十三张表（八表基线 + plugin_settings / routing_rules / event_routing_rules / thread_subscriptions 等），基于 Node 内建 `node:sqlite`，零原生依赖。
- **事件驱动**：Webhook 接入外部事件 + 五种 cordis 内部事件订阅，统一流水去重；observe/auto 双模式规则路由（转述/静音/直投 Worker），多条事件自动合批为一条 Router 通知。
- **Thread 直通**：从事件创建的任务自动订阅来源 Thread，同 Thread 后续事件直投该任务 Worker，不经 Router。
- **上下文召回**：`supervisor_recall` 按事件/任务 ID 一跳召回关联上下文（同 Thread 事件、订阅任务、Worker 汇报、执行历史）。
- **看门狗四分类**：启动超时重试 / 执行超时重试 / 需人工超时升级 / Worker 空闲失联检测，每 5 分钟自动扫描。
- **IM 推送（可选）**：经 dsh-im 把需人工提醒与完成摘要推到飞书/Telegram 等手机 IM，不可用自动降级 Router 会话。
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

详见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)（使用说明）、[docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)（开发方案）、[docs/API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md)（API 使用契约，探针 11/11 VERIFIED + 宿主沙箱契约）、[docs/ITERATION_PLAN.md](docs/ITERATION_PLAN.md)（五阶段迭代方案）、[docs/TEST_PLAN.md](docs/TEST_PLAN.md)（测试与验收映射）、[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)（部署运维）、[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)（排障）、[AGENTS.md](AGENTS.md)（工程纪律）。

## 状态

当前版本 0.4.0：**迭代方案五个阶段全部完成**——事件基础设施（Webhook + cordis 订阅）、Eval 决策层（observe/auto 规则路由）、Thread 订阅直通、多信道通知（dsh-im 优先降级会话）、上下文管理（事件合批 + 链式召回）与看门狗四分类。22 个工具、174/174 单测全绿；五阶段完整性测试在真实 Host 通过（探针 11/11 VERIFIED、Webhook 七例矩阵、端到端合批回路、看门狗升级实测，见 API_COMPATIBILITY 变更记录）。IM 首条真实投递待用户配置 bot 后触发。

## License

MIT
