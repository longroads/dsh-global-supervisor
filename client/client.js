window.__ModuleLoader__.load({ id: "dsh-global-supervisor", factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/src/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var inject = ["slots"];
function api(path) {
  const relative = path.replace(/^\/+/, "");
  if (typeof document === "undefined") return `/${relative}`;
  return new URL(relative, document.baseURI).pathname;
}
var style = {
  card: { display: "grid", gap: "12px", padding: "16px", fontSize: "14px" },
  row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  label: { minWidth: "72px", opacity: "0.8" },
  select: { padding: "4px 8px", minWidth: "220px" },
  button: { padding: "6px 16px", cursor: "pointer" },
  hint: { opacity: 0.7, fontSize: "12px" }
};
function SupervisorPanel() {
  const [data, setData] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)("");
  const [mode, setMode] = (0, import_react.useState)("session");
  const [workspaceId, setWorkspaceId] = (0, import_react.useState)("");
  const [sessionId, setSessionId] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [result, setResult] = (0, import_react.useState)("");
  const [checkingUpdate, setCheckingUpdate] = (0, import_react.useState)(false);
  const reload = (0, import_react.useCallback)(() => {
    setError("");
    fetch(api("global-supervisor/settings")).then((r) => r.json()).then((payload) => {
      setData(payload);
      if (payload.router) {
        setMode(payload.router.mode === "workspace" ? "workspace" : "session");
        setSessionId(payload.router.sessionId);
        setWorkspaceId(payload.router.workspaceId ?? "");
      }
    }).catch((e) => setError(String(e)));
  }, []);
  (0, import_react.useEffect)(() => {
    reload();
  }, [reload]);
  const submit = (0, import_react.useCallback)(() => {
    setBusy(true);
    setResult("");
    const body = mode === "workspace" ? { mode, sessionId, workspaceId } : { mode, sessionId };
    fetch(api("global-supervisor/claim"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, payload: await r.json() })).then(({ ok, payload }) => {
      setResult(ok ? "\u5DF2\u4FDD\u5B58\uFF08\u5373\u65F6\u751F\u6548\uFF09" : `\u5931\u8D25\uFF1A${String(payload["error"] ?? payload["reason"] ?? "unknown")}`);
      if (ok) reload();
    }).catch((e) => setResult(`\u5931\u8D25\uFF1A${String(e)}`)).finally(() => {
      setBusy(false);
    });
  }, [mode, sessionId, workspaceId, reload]);
  const checkUpdate = (0, import_react.useCallback)(() => {
    setCheckingUpdate(true);
    fetch(api("global-supervisor/update-check"), { method: "POST" }).then((r) => r.json()).then((payload) => {
      if (payload.state) setData((prev) => prev === null ? prev : { ...prev, update: payload.state });
    }).catch((e) => setResult(`\u68C0\u67E5\u66F4\u65B0\u5931\u8D25\uFF1A${String(e)}`)).finally(() => setCheckingUpdate(false));
  }, []);
  if (error !== "") return (0, import_react.createElement)("div", { style: style.card }, `\u52A0\u8F7D\u5931\u8D25\uFF1A${error}`);
  if (data === null) return (0, import_react.createElement)("div", { style: style.card }, "\u52A0\u8F7D\u4E2D\u2026");
  const selectedWorkspace = data.workspaces.find((w) => w.id === workspaceId);
  const sessionOptions = mode === "workspace" ? (selectedWorkspace?.sessions ?? []).map((s) => ({ id: s.id, label: s.label })) : data.workspaces.flatMap((w) => w.sessions.map((s) => ({ id: s.id, label: `${w.title} / ${s.label}` })));
  return (0, import_react.createElement)(
    "div",
    { style: style.card },
    (0, import_react.createElement)(
      "div",
      { style: style.row },
      (0, import_react.createElement)("span", { style: style.label }, "\u5F53\u524D Router"),
      (0, import_react.createElement)("strong", null, data.router ? `${data.router.source === "preset" ? "\uFF08\u9884\u7F6E\uFF09" : ""}${data.router.mode === "workspace" ? "\u5DE5\u4F5C\u533A\u6A21\u5F0F" : "\u4F1A\u8BDD\u6A21\u5F0F"} \xB7 ${data.router.sessionId.slice(0, 18)}\u2026${data.router.claimedAt ? `\uFF08${data.router.claimedAt.slice(0, 10)} \u8BBE\u7F6E\uFF09` : ""}` : "\u672A\u8BBE\u7F6E\uFF08\u65E0\u9884\u7F6E\u4E14\u672A\u6307\u6D3E\uFF09")
    ),
    data.update ? (0, import_react.createElement)(
      "div",
      { style: style.row },
      (0, import_react.createElement)("span", { style: style.label }, "\u7248\u672C"),
      (0, import_react.createElement)("span", null, data.update.updateAvailable && data.update.latest ? `\u53D1\u73B0\u65B0\u7248\u672C v${data.update.latest}\uFF08\u5F53\u524D v${data.update.current}\uFF09\u3002\u5347\u7EA7\uFF1Adsh plugin --profile desktop update dsh-global-supervisor` : data.update.disabled ? `v${data.update.current}\uFF08\u66F4\u65B0\u68C0\u67E5\u5DF2\u7981\u7528\uFF09` : data.update.latest !== null ? `v${data.update.current}\uFF08\u5DF2\u662F\u6700\u65B0${data.update.source === "npmmirror" ? " \xB7 npmmirror" : ""}\uFF09` : data.update.error !== null ? `v${data.update.current}\uFF08\u68C0\u67E5\u5931\u8D25\uFF1A${data.update.error}\uFF09` : `v${data.update.current}`),
      (0, import_react.createElement)("button", { style: style.button, disabled: checkingUpdate, onClick: checkUpdate }, checkingUpdate ? "\u68C0\u67E5\u4E2D\u2026" : "\u68C0\u67E5\u66F4\u65B0")
    ) : null,
    (0, import_react.createElement)(
      "div",
      { style: style.row },
      (0, import_react.createElement)("span", { style: style.label }, "\u6A21\u5F0F"),
      (0, import_react.createElement)("label", null, (0, import_react.createElement)("input", { type: "radio", checked: mode === "session", onChange: () => setMode("session") }), " \u4EC5\u6307\u5B9A\u4F1A\u8BDD"),
      (0, import_react.createElement)("label", null, (0, import_react.createElement)("input", { type: "radio", checked: mode === "workspace", onChange: () => setMode("workspace") }), " \u6574\u4E2A\u5DE5\u4F5C\u533A")
    ),
    mode === "workspace" ? (0, import_react.createElement)(
      "div",
      { style: style.row },
      (0, import_react.createElement)("span", { style: style.label }, "\u5DE5\u4F5C\u533A"),
      (0, import_react.createElement)(
        "select",
        { style: style.select, value: workspaceId, onChange: (e) => {
          setWorkspaceId(e.target.value);
          setSessionId("");
        } },
        (0, import_react.createElement)("option", { value: "" }, "\u2014 \u9009\u62E9\u5DE5\u4F5C\u533A \u2014"),
        ...data.workspaces.map((w) => (0, import_react.createElement)("option", { key: w.id, value: w.id }, `${w.title}\uFF08${w.sessions.length} \u4F1A\u8BDD\uFF09`))
      )
    ) : null,
    (0, import_react.createElement)(
      "div",
      { style: style.row },
      (0, import_react.createElement)("span", { style: style.label }, "Router \u4F1A\u8BDD"),
      (0, import_react.createElement)(
        "select",
        { style: style.select, value: sessionId, onChange: (e) => setSessionId(e.target.value) },
        (0, import_react.createElement)("option", { value: "" }, "\u2014 \u9009\u62E9\u4F1A\u8BDD \u2014"),
        ...sessionOptions.map((s) => (0, import_react.createElement)("option", { key: s.id, value: s.id }, s.label))
      ),
      (0, import_react.createElement)("span", { style: style.hint }, mode === "workspace" ? "\u8BE5\u5DE5\u4F5C\u533A\u4E0B\u5168\u90E8\u4F1A\u8BDD\u5747\u4E3A Router\uFF08\u8BA4\u9886\u53D1\u8D77\u8005\u8BB0\u5F55\uFF09" : "\u4EC5\u8BE5\u4F1A\u8BDD\u53EF\u8C03\u7528 supervisor \u5DE5\u5177")
    ),
    (0, import_react.createElement)(
      "div",
      { style: style.row },
      (0, import_react.createElement)("button", { style: style.button, disabled: busy || sessionId === "" || mode === "workspace" && workspaceId === "", onClick: submit }, busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58"),
      result !== "" ? (0, import_react.createElement)("span", null, result) : null
    ),
    (0, import_react.createElement)("div", { style: style.hint }, "\u4FDD\u5B58\u540E\u5373\u65F6\u751F\u6548\uFF08\u65E0\u9700\u91CD\u542F\uFF09\uFF1B\u6B64\u524D\u521B\u5EFA\u7684\u5B9A\u65F6\u5DE1\u68C0\u6295\u9012\u76EE\u6807\u4E0D\u81EA\u52A8\u8FC1\u79FB\uFF0C\u8BF7\u91CD\u8BBE\u8C03\u5EA6\u3002")
  );
}
function apply(ctx) {
  const report = (phase, extra) => {
    void fetch(api("global-supervisor/client-ping"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase, ...extra })
    }).catch(() => void 0);
  };
  try {
    ctx.slots.inject("settings.section", () => {
      try {
        const off = ctx.slots.register(
          {
            name: "settings.section",
            id: "global-supervisor",
            order: 60,
            label: () => "\u5168\u5C40\u76D1\u7763"
          },
          () => (0, import_react.createElement)(SupervisorPanel)
        );
        report("registered", { registered: true, disposer: typeof off === "function" });
      } catch (e) {
        report("register-failed", { error: String(e) });
      }
    });
    report("apply", { registered: false });
  } catch (e) {
    report("apply-failed", { error: String(e) });
  }
  if (typeof ctx.effect === "function") {
    ctx.effect(() => void 0, "global-supervisor: settings section");
  }
}

return module.exports;
}});
