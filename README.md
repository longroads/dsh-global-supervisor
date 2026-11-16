# dsh-global-supervisor

> [简体中文](README.zh-CN.md) | **English**

Global supervisor plugin for DSH (DeepSeek Harness): cross-workspace project management, task dispatch, status monitoring, scheduled inspections, and event response — without modifying DSH core.

A single Router session manages many project workspaces: identify projects, dispatch tasks, resume sessions, receive structured worker reports, run periodic patrols. All state persists in SQLite and survives host restarts.

## Highlights

- **Router/Worker split** — the Router session holds 24 `supervisor_*` tools; worker sessions report via `worker_report` with server-side permission checks (not prompt constraints).
- **Task state machine** — `pending → queued → running → completed` plus `blocked / need_human / failed / canceled`; strict transition table with audit trail; Task/TaskRun separation keeps retry history intact.
- **SQLite persistence** — 13 tables on built-in `node:sqlite`, zero native dependencies.
- **Event-driven** — webhook intake + 5 cordis event subscriptions with a unified dedup pipeline; observe/auto rule routing; multiple events batched into one Router notification.
- **Thread passthrough** — tasks created from an event auto-subscribe to its thread; follow-up events on the same thread go straight to the assigned worker, bypassing the Router.
- **Context recall** — `supervisor_recall` pulls related context (thread events, subscriptions, worker reports, run history) in one hop.
- **Watchdog, 4 classes** — startup-timeout retry, run-timeout retry, need-human escalation, idle/lost worker detection; 5-minute scans.
- **IM push (optional)** — need-human alerts and completion summaries to Feishu/Telegram etc. via dsh-im, with automatic fallback to the Router session.
- **Model control** — per-task / per-project model selection and switching; `steer` to inject instructions into a running task.
- **Serial dispatch** — ModelQueue defaults to concurrency 1 with priority queue-jumping that never preempts a running task, tuned for local inference.
- **Scheduled inspections** — reuses the DSH native host-wide Schedule service (0.2.2-rc.x); no custom cron.
- **Built-in update check** — the settings panel probes the latest npm release (with npmmirror fallback) and shows an upgrade hint when a newer version exists.

## Requirements

- DSH Desktop **0.2.2-rc.x** (host-wide Schedule requires 0.2.x; 0.1.x is incompatible)
- Node ≥ 22.19 (built-in `node:sqlite`; shipped with the DSH runtime)

## Install

```powershell
# Run in the DSH Desktop built-in terminal (replace "desktop" with your profile name)
dsh plugin --profile desktop add dsh-global-supervisor
```

Restart DSH Desktop. **Installing is not enough**: open the settings panel ("Global Supervisor") and assign a Router session first. IM push is optional (configure a dsh-im bot). Patch-level configuration options: see `cordis.patch.yml`.

## Upgrade

Open the settings panel — it checks for new releases (npmjs, npmmirror fallback) and shows the upgrade command:

```powershell
dsh plugin --profile desktop update dsh-global-supervisor
```

## Documentation

Full documentation ships inside the npm package (in Chinese) at `node_modules/dsh-global-supervisor/docs/`: USER_GUIDE (usage), TROUBLESHOOTING (troubleshooting), DEPLOYMENT (deployment & operations), INTEGRATIONS (external integration examples), API_COMPATIBILITY (host compatibility contract).

## Status

Version 0.5.6 — the full planned feature set is complete: 25 tools (24 Router + `worker_report`), 204 unit tests, and every major flow verified end-to-end against a real DSH Desktop 0.2.2-rc.x host.

## License

MIT
