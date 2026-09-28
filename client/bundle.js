/* dsh-mcp-manager — Client half (web bundle, hand-written to match the
 * client-modules bundle protocol: window.__ModuleLoader__.load registers a
 * factory that receives a CommonJS require).
 *
 * 在 DSH 设置页新增一页「MCP 服务器」：列出当前 profile 里配置的 MCP 服务器，
 * 支持新增 / 编辑 / 删除 / 启用停用，并显示每个服务器的运行状态。
 *
 * 数据全部来自 host 半边的 HTTP 路由（/mcp-manager/*），本文件不直接碰文件系统。
 * 视觉使用 DSH 主题 token（--dsw-alias-*），明暗主题自适应；ES5 风格，无构建步骤。
 */
window.__ModuleLoader__.load({
  id: "dsh-mcp-manager",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")

    var API = "/mcp-manager"

    var CSS = [
      ".mm-root { display:flex; flex-direction:column; gap:14px; padding:4px 2px 24px; font-family:inherit; color:var(--dsw-alias-label-primary, #1a1a1a); }",
      ".mm-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }",
      ".mm-title { font-size:16px; font-weight:600; margin:0; }",
      ".mm-desc { font-size:12px; color:var(--dsw-alias-label-secondary, #555); margin-top:4px; line-height:1.6; }",
      ".mm-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; word-break:break-all; }",
      ".mm-actions { display:flex; gap:8px; align-items:center; flex-shrink:0; }",
      ".mm-btn { border:1px solid var(--dsw-alias-border-l2, #d5d5d5); border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary, #222); padding:6px 14px; font-size:13px; cursor:pointer; font-family:inherit; white-space:nowrap; transition:background .15s ease, border-color .15s ease; }",
      ".mm-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); }",
      ".mm-btn:disabled { opacity:.5; cursor:default; }",
      ".mm-btn-primary { background:var(--dsw-alias-brand-primary, #4f8cff); border-color:var(--dsw-alias-brand-primary, #4f8cff); color:#fff; }",
      ".mm-btn-primary:hover:not(:disabled) { filter:brightness(1.06); }",
      ".mm-btn-danger { color:var(--dsw-alias-state-error-primary, #d64545); border-color:var(--dsw-alias-state-error-primary, #d64545); }",
      ".mm-btn-sm { padding:4px 10px; font-size:12px; border-radius:7px; }",
      ".mm-notice { border:1px solid var(--dsw-alias-border-l2, #e5e5e5); border-left:3px solid var(--dsw-alias-brand-primary, #4f8cff); border-radius:6px; padding:8px 12px; font-size:12px; background:var(--dsw-alias-bg-layer-1, #fff); line-height:1.6; }",
      ".mm-warn { border-left-color:var(--dsw-alias-state-warn-primary, #d6913f); }",
      ".mm-err { border-left-color:var(--dsw-alias-state-error-primary, #d64545); }",
      ".mm-list { display:flex; flex-direction:column; gap:10px; }",
      ".mm-card { border:1px solid var(--dsw-alias-border-l2, #e5e5e5); border-radius:10px; background:var(--dsw-alias-bg-layer-1, #fff); padding:12px 14px; display:flex; flex-direction:column; gap:8px; }",
      ".mm-card-main { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:space-between; }",
      ".mm-name { font-size:14px; font-weight:600; }",
      ".mm-id { font-size:11px; color:var(--dsw-alias-label-secondary, #666); }",
      ".mm-badge { display:inline-flex; align-items:center; gap:5px; font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2, #ddd); color:var(--dsw-alias-label-secondary, #555); }",
      ".mm-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }",
      ".mm-live { color:var(--dsw-alias-state-success-primary, #2f9e63); }",
      ".mm-idle { color:var(--dsw-alias-state-idle-primary, #8a8a8a); }",
      ".mm-pending { color:var(--dsw-alias-state-warn-primary, #d6913f); }",
      ".mm-failed { color:var(--dsw-alias-state-error-primary, #d64545); }",
      ".mm-meta { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; color:var(--dsw-alias-label-secondary, #555); }",
      ".mm-meta-key { color:var(--dsw-alias-label-secondary, #777); opacity:.85; }",
      ".mm-row-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }",
      ".mm-empty { border:1px dashed var(--dsw-alias-border-l2, #d5d5d5); border-radius:10px; padding:22px; text-align:center; font-size:13px; color:var(--dsw-alias-label-secondary, #666); }",
      ".mm-form { border:1px solid var(--dsw-alias-border-l2, #e5e5e5); border-radius:10px; padding:14px; background:var(--dsw-alias-bg-layer-2, #fafafa); display:flex; flex-direction:column; gap:10px; }",
      ".mm-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }",
      ".mm-field { display:flex; flex-direction:column; gap:4px; min-width:0; }",
      ".mm-label { font-size:12px; color:var(--dsw-alias-label-secondary, #555); }",
      ".mm-hint { font-size:11px; color:var(--dsw-alias-label-secondary, #888); opacity:.9; }",
      ".mm-input, .mm-select, .mm-textarea { border:1px solid var(--dsw-alias-border-l2, #d5d5d5); border-radius:7px; background:var(--dsw-alias-bg-layer-1, #fff); color:var(--dsw-alias-label-primary, #222); padding:6px 8px; font-size:13px; font-family:inherit; width:100%; box-sizing:border-box; }",
      ".mm-textarea { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; resize:vertical; min-height:60px; }",
      ".mm-check { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary, #555); }",
      ".mm-errlist { margin:0; padding-left:18px; font-size:12px; color:var(--dsw-alias-state-error-primary, #d64545); line-height:1.7; }",
      ".mm-foot { display:flex; gap:8px; align-items:center; justify-content:flex-end; }",
      ".mm-advanced { font-size:12px; color:var(--dsw-alias-label-secondary, #666); cursor:pointer; user-select:none; }",
      ".mm-pre { margin:0; padding:10px; border-radius:8px; background:var(--dsw-alias-bg-layer-2, #f5f5f5); border:1px solid var(--dsw-alias-border-l1, #eee); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-all; }"
    ].join("\n")

    function api(path, body) {
      var init = { cache: "no-store", headers: { "Content-Type": "application/json" } }
      if (body) {
        init.method = "POST"
        init.body = JSON.stringify(body)
      }
      return fetch(API + path, init).then(function (res) {
        return res.json().catch(function () {
          throw new Error("HTTP " + res.status)
        }).then(function (json) {
          if (!res.ok || json.ok === false) {
            var err = new Error(json.error || ("HTTP " + res.status))
            err.details = json.details || null
            throw err
          }
          return json
        })
      })
    }

    function linesFrom(value) {
      if (!value) return ""
      return String(value)
    }

    function dictToText(dict) {
      if (!dict || typeof dict !== "object") return ""
      return Object.keys(dict).map(function (k) { return k + "=" + dict[k] }).join("\n")
    }

    function syncLabel(sync) {
      if (sync === "live") return { text: "运行中", cls: "mm-live" }
      if (sync === "loading") return { text: "连接中", cls: "mm-pending" }
      if (sync === "stopped") return { text: "已停用", cls: "mm-idle" }
      if (sync === "disabled") return { text: "已停用（配置）", cls: "mm-idle" }
      if (sync === "failed") return { text: "加载失败", cls: "mm-failed" }
      if (sync === "external") return { text: "由其它配置层提供", cls: "mm-pending" }
      return { text: "待重启生效", cls: "mm-pending" }
    }

    function Badge(props) {
      var info = syncLabel(props.sync)
      return React.createElement("span", { className: "mm-badge " + info.cls },
        React.createElement("span", { className: "mm-dot" }),
        info.text
      )
    }

    function emptyDraft() {
      return {
        originalId: null,
        id: "",
        serverName: "",
        transport: "stdio",
        command: "",
        args: "",
        env: "",
        cwd: "",
        url: "",
        headers: "",
        toolCallTimeoutMs: "",
        failOnStartupError: false,
        maxInstructionBytes: "",
        reconnectEnabled: false,
        reconnectInitial: "",
        reconnectMax: "",
        reconnectAttempts: ""
      }
    }

    function draftFrom(server) {
      var d = emptyDraft()
      var cfg = server.config || {}
      d.originalId = server.id
      d.id = server.id || ""
      d.serverName = cfg.serverName || ""
      d.transport = cfg.transport === "streamable-http" ? "streamable-http" : "stdio"
      d.command = cfg.command || ""
      d.args = Array.isArray(cfg.args) ? cfg.args.join("\n") : ""
      d.env = dictToText(cfg.env)
      d.cwd = cfg.cwd || ""
      d.url = cfg.url || ""
      d.headers = dictToText(cfg.headers)
      d.toolCallTimeoutMs = cfg.toolCallTimeoutMs === undefined || cfg.toolCallTimeoutMs === null ? "" : String(cfg.toolCallTimeoutMs)
      d.failOnStartupError = cfg.failOnStartupError === true
      d.maxInstructionBytes = cfg.maxInstructionBytes === undefined || cfg.maxInstructionBytes === null ? "" : String(cfg.maxInstructionBytes)
      var rc = cfg.reconnect || null
      if (rc && typeof rc === "object") {
        d.reconnectEnabled = true
        d.reconnectInitial = rc.initialDelayMs === undefined ? "" : String(rc.initialDelayMs)
        d.reconnectMax = rc.maxDelayMs === undefined ? "" : String(rc.maxDelayMs)
        d.reconnectAttempts = rc.maxAttempts === undefined ? "" : String(rc.maxAttempts)
      }
      return d
    }

    function draftToPayload(draft) {
      var payload = {
        id: draft.id,
        serverName: draft.serverName,
        transport: draft.transport,
        command: draft.command,
        args: draft.args,
        env: draft.env,
        cwd: draft.cwd,
        url: draft.url,
        headers: draft.headers,
        failOnStartupError: draft.failOnStartupError
      }
      if (draft.toolCallTimeoutMs !== "") payload.toolCallTimeoutMs = draft.toolCallTimeoutMs
      if (draft.maxInstructionBytes !== "") payload.maxInstructionBytes = draft.maxInstructionBytes
      if (draft.reconnectEnabled) {
        payload.reconnect = { enabled: true }
        if (draft.reconnectInitial !== "") payload.reconnect.initialDelayMs = Number(draft.reconnectInitial)
        if (draft.reconnectMax !== "") payload.reconnect.maxDelayMs = Number(draft.reconnectMax)
        if (draft.reconnectAttempts !== "") payload.reconnect.maxAttempts = Number(draft.reconnectAttempts)
      }
      return payload
    }

    function Field(props) {
      return React.createElement("div", { className: "mm-field", style: props.wide ? { gridColumn: "1 / -1" } : undefined },
        React.createElement("label", { className: "mm-label" }, props.label),
        props.children,
        props.hint ? React.createElement("span", { className: "mm-hint" }, props.hint) : null
      )
    }

    function ServerForm(props) {
      var draft = props.draft
      var setDraft = props.onChange
      var errors = props.errors || []
      var busy = props.busy
      var isEdit = !!draft.originalId

      function set(key) {
        return function (event) {
          var value = event && event.target ? (event.target.type === "checkbox" ? event.target.checked : event.target.value) : event
          var next = {}
          for (var k in draft) if (Object.prototype.hasOwnProperty.call(draft, k)) next[k] = draft[k]
          next[key] = value
          setDraft(next)
        }
      }

      var isStdio = draft.transport !== "streamable-http"

      return React.createElement("div", { className: "mm-form" },
        React.createElement("div", { style: { fontSize: "13px", fontWeight: 600 } }, isEdit ? "编辑 MCP 服务器" : "新增 MCP 服务器"),
        errors.length > 0 ? React.createElement("ul", { className: "mm-errlist" }, errors.map(function (e, i) {
          return React.createElement("li", { key: i }, e)
        })) : null,
        React.createElement("div", { className: "mm-grid" },
          React.createElement(Field, { label: "服务器名称 (serverName)", hint: "决定工具名 mcp__<名称>__<工具>，只能字母数字下划线连字符，1–32 位" },
            React.createElement("input", { className: "mm-input", value: draft.serverName, onChange: set("serverName"), placeholder: "comfy" })
          ),
          React.createElement(Field, { label: "传输方式", hint: isStdio ? "stdio：拉起本地子进程（本地 MCP 服务器）" : "streamable-http：连接远程 MCP 服务" },
            React.createElement("select", { className: "mm-select", value: draft.transport, onChange: set("transport") },
              React.createElement("option", { value: "stdio" }, "stdio（本地进程）"),
              React.createElement("option", { value: "streamable-http" }, "streamable-http（远程）")
            )
          )
        ),
        isStdio ? React.createElement("div", null,
          React.createElement("div", { className: "mm-grid" },
            React.createElement(Field, { label: "启动命令 (command)", hint: "可执行文件或命令名；参数不要写在这里", wide: true },
              React.createElement("input", { className: "mm-input", value: draft.command, onChange: set("command"), placeholder: "D:\\tools\\mcp-server.exe 或 npx" })
            ),
            React.createElement(Field, { label: "参数 (args)", hint: "每行一个参数，不要加引号" },
              React.createElement("textarea", { className: "mm-textarea", value: draft.args, onChange: set("args"), placeholder: "-y\n@modelcontextprotocol/server-filesystem\nD:\\work" })
            ),
            React.createElement(Field, { label: "环境变量 (env)", hint: "每行 KEY=VALUE" },
              React.createElement("textarea", { className: "mm-textarea", value: draft.env, onChange: set("env"), placeholder: "API_KEY=xxx" })
            ),
            React.createElement(Field, { label: "工作目录 (cwd)", hint: "可留空", wide: true },
              React.createElement("input", { className: "mm-input", value: draft.cwd, onChange: set("cwd"), placeholder: "D:\\work" })
            )
          )
        ) : React.createElement("div", { className: "mm-grid" },
          React.createElement(Field, { label: "服务地址 (url)", hint: "MCP 端点，必须 http:// 或 https:// 开头", wide: true },
            React.createElement("input", { className: "mm-input", value: draft.url, onChange: set("url"), placeholder: "https://example.com/mcp" })
          ),
          React.createElement(Field, { label: "请求头 (headers)", hint: "每行 KEY=VALUE，可放 Authorization", wide: true },
            React.createElement("textarea", { className: "mm-textarea", value: draft.headers, onChange: set("headers"), placeholder: "Authorization=Bearer xxx" })
          )
        ),
        React.createElement("div", { className: "mm-grid" },
          React.createElement(Field, { label: "条目 ID", hint: "profile 文件里的条目标识，留空自动生成 mcp-<服务器名称>；改 ID 会重建条目" },
            React.createElement("input", { className: "mm-input", value: draft.id, onChange: set("id"), placeholder: "mcp-comfy", disabled: false })
          ),
          React.createElement(Field, { label: "工具调用超时 (ms)", hint: "留空使用插件默认值" },
            React.createElement("input", { className: "mm-input", value: draft.toolCallTimeoutMs, onChange: set("toolCallTimeoutMs"), placeholder: "600000" })
          )
        ),
        React.createElement("div", { className: "mm-row-actions" },
          React.createElement("label", { className: "mm-check" },
            React.createElement("input", { type: "checkbox", checked: draft.failOnStartupError, onChange: set("failOnStartupError") }),
            "启动连接失败时让插件加载失败（failOnStartupError）"
          ),
          React.createElement("label", { className: "mm-check" },
            React.createElement("input", { type: "checkbox", checked: draft.reconnectEnabled, onChange: set("reconnectEnabled") }),
            "自定义重连策略"
          )
        ),
        draft.reconnectEnabled ? React.createElement("div", { className: "mm-grid" },
          React.createElement(Field, { label: "首次重连延迟 (ms)", hint: "默认 500" },
            React.createElement("input", { className: "mm-input", value: draft.reconnectInitial, onChange: set("reconnectInitial") })
          ),
          React.createElement(Field, { label: "重连间隔上限 (ms)", hint: "默认 30000" },
            React.createElement("input", { className: "mm-input", value: draft.reconnectMax, onChange: set("reconnectMax") })
          ),
          React.createElement(Field, { label: "每次断线最多重试次数", hint: "默认 10" },
            React.createElement("input", { className: "mm-input", value: draft.reconnectAttempts, onChange: set("reconnectAttempts") })
          )
        ) : null,
        React.createElement("div", { className: "mm-foot" },
          React.createElement("button", { className: "mm-btn", onClick: props.onCancel, disabled: busy }, "取消"),
          React.createElement("button", { className: "mm-btn mm-btn-primary", onClick: props.onSave, disabled: busy },
            busy ? "保存中…" : (isEdit ? "保存修改" : "添加服务器"))
        )
      )
    }

    function ServerCard(props) {
      var server = props.server
      var summary = server.summary || {}
      var busy = props.busy
      var confirming = props.confirming
      var isExternal = server.external === true

      var detail = summary.transport === "streamable-http"
        ? summary.url
        : [summary.command].concat(summary.argsCount > 0 ? ["（" + summary.argsCount + " 个参数）"] : []).join(" ")

      return React.createElement("div", { className: "mm-card" },
        React.createElement("div", { className: "mm-card-main" },
          React.createElement("div", null,
            React.createElement("div", { className: "mm-name" }, summary.serverName || server.id || "（未命名）"),
            React.createElement("div", { className: "mm-id mm-mono" }, server.id || "")
          ),
          React.createElement("div", { className: "mm-row-actions" },
            React.createElement(Badge, { sync: server.sync }),
            React.createElement("button", {
              className: "mm-btn mm-btn-sm",
              disabled: busy || isExternal,
              onClick: props.onToggle,
              title: server.sync === "stopped" || server.sync === "disabled" ? "启用该服务器" : "停用该服务器"
            }, server.sync === "stopped" || server.sync === "disabled" ? "启用" : "停用"),
            React.createElement("button", { className: "mm-btn mm-btn-sm", disabled: busy || isExternal || !!server.parseError, onClick: props.onEdit }, "编辑"),
            React.createElement("button", { className: "mm-btn mm-btn-sm mm-btn-danger", disabled: busy || isExternal, onClick: props.onRemoveClick }, "删除")
          )
        ),
        React.createElement("div", { className: "mm-meta" },
          React.createElement("span", { className: "mm-meta-key" }, "传输"),
          React.createElement("span", null, summary.transport || "—"),
          React.createElement("span", { className: "mm-meta-key" }, "启动"),
          React.createElement("span", { className: "mm-mono" }, detail || "—"),
          summary.envKeys && summary.envKeys.length > 0 ? React.createElement("span", { className: "mm-meta-key" }, "环境变量") : null,
          summary.envKeys && summary.envKeys.length > 0 ? React.createElement("span", { className: "mm-mono" }, summary.envKeys.join(", ")) : null,
          summary.headerKeys && summary.headerKeys.length > 0 ? React.createElement("span", { className: "mm-meta-key" }, "请求头") : null,
          summary.headerKeys && summary.headerKeys.length > 0 ? React.createElement("span", { className: "mm-mono" }, summary.headerKeys.join(", ")) : null,
          summary.toolCallTimeoutMs ? React.createElement("span", { className: "mm-meta-key" }, "调用超时") : null,
          summary.toolCallTimeoutMs ? React.createElement("span", null, summary.toolCallTimeoutMs + " ms") : null,
          React.createElement("span", { className: "mm-meta-key" }, "运行状态"),
          React.createElement("span", null, server.live
            ? (server.live.enabled === false ? "条目已停用" : "加载阶段：" + (server.live.phase || "未知"))
            : (isExternal ? "由其它配置层提供" : "当前进程里没有这个条目，重启后加载"))
        ),
        server.parseError ? React.createElement("div", { className: "mm-notice mm-err" }, "这个条目无法被解析（" + server.parseError + "），请手动检查配置文件。") : null,
        confirming ? React.createElement("div", { className: "mm-row-actions" },
          React.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #d64545)" } }, "确认删除该服务器？"),
          React.createElement("button", { className: "mm-btn mm-btn-sm mm-btn-danger", disabled: busy, onClick: props.onRemoveConfirm }, busy ? "删除中…" : "确认删除"),
          React.createElement("button", { className: "mm-btn mm-btn-sm", disabled: busy, onClick: props.onRemoveCancel }, "取消")
        ) : null
      )
    }

    function Panel() {
      var stateHook = React.useState(null)
      var data = stateHook[0]
      var setData = stateHook[1]
      var busyHook = React.useState(false)
      var busy = busyHook[0]
      var setBusy = busyHook[1]
      var errHook = React.useState(null)
      var error = errHook[0]
      var setError = errHook[1]
      var noticeHook = React.useState(null)
      var notice = noticeHook[0]
      var setNotice = noticeHook[1]
      var draftHook = React.useState(null)
      var draft = draftHook[0]
      var setDraft = draftHook[1]
      var formErrorsHook = React.useState([])
      var formErrors = formErrorsHook[0]
      var setFormErrors = formErrorsHook[1]
      var confirmHook = React.useState(null)
      var confirmId = confirmHook[0]
      var setConfirmId = confirmHook[1]
      var rawHook = React.useState(null)
      var raw = rawHook[0]
      var setRaw = rawHook[1]

      function load(keepNotice) {
        setBusy(true)
        return api("/state").then(function (json) {
          setData(json)
          setError(null)
          if (!keepNotice) setNotice(null)
        }).catch(function (e) {
          setError(e.message)
        }).then(function () { setBusy(false) })
      }

      React.useEffect(function () { load(false) }, [])

      function save() {
        if (!draft) return
        setBusy(true)
        setFormErrors([])
        api("/save", { server: draftToPayload(draft), originalId: draft.originalId })
          .then(function (res) {
            setDraft(null)
            setNotice(res.note || "已保存，重启 DSH 后生效。")
            return load(true)
          })
          .catch(function (e) {
            setFormErrors(e.details && e.details.length ? e.details : [e.message])
            setError(e.details && e.details.length ? null : e.message)
          })
          .then(function () { setBusy(false) })
      }

      function remove(id) {
        setBusy(true)
        api("/remove", { id: id })
          .then(function (res) {
            setConfirmId(null)
            setNotice(res.note || "已删除，重启 DSH 后生效。")
            return load(true)
          })
          .catch(function (e) { setError(e.message) })
          .then(function () { setBusy(false) })
      }

      function toggle(server) {
        var enable = server.sync === "stopped" || server.sync === "disabled"
        setBusy(true)
        api("/toggle", { id: server.id, enabled: enable })
          .then(function (res) {
            setNotice(res.note || null)
            return load(true)
          })
          .catch(function (e) { setError(e.message) })
          .then(function () { setBusy(false) })
      }

      function showRaw() {
        setBusy(true)
        api("/raw")
          .then(function (json) { setRaw(json.text || "") })
          .catch(function (e) { setError(e.message) })
          .then(function () { setBusy(false) })
      }

      var servers = data && data.servers ? data.servers.filter(function (s) { return s.external !== true }) : []
      var counts = data && data.counts ? data.counts : null
      var profile = data && data.profile ? data.profile : null
      var warnings = data && data.warnings ? data.warnings : []

      return React.createElement("div", { className: "mm-root" },
        React.createElement("div", { className: "mm-head" },
          React.createElement("div", null,
            React.createElement("h3", { className: "mm-title" }, "MCP 服务器"),
            React.createElement("div", { className: "mm-desc" },
              "管理 DSH 桌面端当前 profile 里的 MCP 服务器：新增、编辑、删除、启用停用。",
              React.createElement("br"),
              "写入目标：",
              React.createElement("span", { className: "mm-mono" }, profile && profile.file ? profile.file : "（未定位到 profile）"),
              profile && profile.source ? React.createElement("span", null, "（定位方式：" + profile.source + "）") : null
            )
          ),
          React.createElement("div", { className: "mm-actions" },
            React.createElement("button", { className: "mm-btn", onClick: showRaw, disabled: busy }, "查看配置文件"),
            React.createElement("button", { className: "mm-btn", onClick: function () { load(false) }, disabled: busy }, busy ? "刷新中…" : "刷新"),
            React.createElement("button", {
              className: "mm-btn mm-btn-primary",
              disabled: busy,
              onClick: function () { setDraft(emptyDraft()); setFormErrors([]) }
            }, "新增服务器")
          )
        ),

        error ? React.createElement("div", { className: "mm-notice mm-err" }, "出错了：" + error) : null,
        notice ? React.createElement("div", { className: "mm-notice mm-warn" }, notice) : null,
        counts && counts.pending > 0 ? React.createElement("div", { className: "mm-notice mm-warn" },
          "有 " + counts.pending + " 个服务器只在配置文件里存在，DSH 重启后才会连接。"
        ) : null,
        profile && profile.exists === false ? React.createElement("div", { className: "mm-notice mm-warn" },
          "没有找到 cordis.patch.yml。可以先在 DSH 里装任意一个插件让 profile 生成该文件，或检查 profile 目录是否正确。"
        ) : null,
        profile && profile.exists === true && profile.writable === false ? React.createElement("div", { className: "mm-notice mm-err" },
          "配置文件不可写，保存会失败：请检查文件权限。"
        ) : null,
        warnings.map(function (w, i) {
          return React.createElement("div", { key: i, className: "mm-notice mm-warn" }, w)
        }),

        raw !== null ? React.createElement("div", null,
          React.createElement("div", { className: "mm-card-main", style: { marginBottom: "6px" } },
            React.createElement("span", { className: "mm-label" }, "cordis.patch.yml 原文（只读）"),
            React.createElement("button", { className: "mm-btn mm-btn-sm", onClick: function () { setRaw(null) } }, "收起")
          ),
          React.createElement("pre", { className: "mm-pre" }, raw)
        ) : null,

        draft ? React.createElement(ServerForm, {
          draft: draft,
          errors: formErrors,
          busy: busy,
          onChange: setDraft,
          onCancel: function () { setDraft(null); setFormErrors([]) },
          onSave: save
        }) : null,

        servers.length === 0
          ? React.createElement("div", { className: "mm-empty" },
              data === null
                ? "正在读取配置…"
                : "当前 profile 里还没有 MCP 服务器。点击右上角「新增服务器」添加第一个。"
            )
          : React.createElement("div", { className: "mm-list" }, servers.map(function (server) {
              return React.createElement(ServerCard, {
                key: server.id,
                server: server,
                busy: busy,
                confirming: confirmId === server.id,
                onToggle: function () { toggle(server) },
                onEdit: function () { setDraft(draftFrom(server)); setFormErrors([]); setNotice(null) },
                onRemoveClick: function () { setConfirmId(server.id) },
                onRemoveCancel: function () { setConfirmId(null) },
                onRemoveConfirm: function () { remove(server.id) }
              })
            })),

        React.createElement("div", { className: "mm-desc" },
          "说明：新增、编辑、删除会直接改写 profile 的 cordis.patch.yml（改动前自动备份，最多保留 10 份 .bak-mcp-manager-*）。",
          React.createElement("br"),
          "DSH 的 Loader 不会热重载 profile patch，因此这三类改动需要重启 DSH 才生效；「停用/启用」在运行中的条目上会走 pluginManager 立即生效。"
        )
      )
    }

    var inject = ["slots"]

    function apply(ctx) {
      var style = document.createElement("style")
      style.setAttribute("data-plugin", "dsh-mcp-manager")
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(function () {
        return function () {
          if (style.parentNode) style.parentNode.removeChild(style)
        }
      })

      var slots = ctx.get("slots")
      if (slots === undefined) return
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "mcp-manager", order: 12, label: "MCP 服务器" },
          function () { return React.createElement(Panel) }
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
