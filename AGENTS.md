# AGENTS.md

DSH（DeepSeek Harness）插件：在桌面端设置页里管理 MCP 服务器。host 半边负责读写 profile 的 `cordis.patch.yml` 并暴露 HTTP 路由，浏览器半边画设置页。

## Layout

- `src/index.js` — host 半边，Cordis 插件（`module.exports = { name, inject, apply(ctx, config) }`）。`inject: ['webServer']`，可选使用 `ctx.get('pluginManager')`、`ctx.get('configEditor')`。包入口（`package.json` → `main`）。
- `src/patch-file.js` / `src/yaml-mini.js` — 纯逻辑：扫描 `cordis.patch.yml`、按行增删改条目；自带最小 YAML 读写（**不要**为了省事引入 `yaml`/`js-yaml`，零依赖是刻意选择，见下）。
- `src/validate.js` — 表单校验与配置规范化，字段与默认值必须对齐已安装的 `@deepseek-ai/dsh-mcp-client` 的 Schemastery schema。
- `src/locate.js` — profile 目录定位。
- `client/bundle.js` — 浏览器半边，**手写** bundle，遵循 client-modules 协议（`window.__ModuleLoader__.load({ id, factory(require) })`），导出 `inject = ['slots']` 与 `apply(ctx)`；注册到根级 `settings.section`（id `mcp-manager`，label `MCP 服务器`）。无构建步骤：保持 ES5 风格（`var` + `function` + `React.createElement`，不用 JSX / 箭头函数 / 模板字符串）。
- `cordis.patch.yml` — `dsh.bundle.patch`：通过 `dsh plugin add` 安装时把插件条目插入 profile 的 host 组合。必须留在 host 平面（它读 `webServer`）。
- `tools/inspect-patch.js` — 排错工具，只读打印 patch 文件的解析结果。

## 契约（不要破坏）

- **写文件只做行级编辑。** 每次只替换/插入/删除目标条目的行范围，文件其余部分必须逐字节保留（用户注释、其它插件、`!!js` 表达式）。测试里用「含注释的样例 + CRLF + 幂等」三类断言盯着这一点。
- **`- insert:` 的键在第 2 列**（`- ` 占两列），块内普通行的键也在第 2 列 —— `scanPatch` 两处都要覆盖。历史 bug：只判 `indentOf(raw) === 2` 会导致真实文件里一个 insert 块都找不到。
- **id 查重必须包含顶层 `- id:` 条目**（`collectEntryIds`），不只是 insert 里的条目，否则会写出同 id 冲突的 patch。
- **写盘顺序：备份 → 原子写（tmp + rename）→ 回读校验。** 回读拿不到目标条目就抛错，不能当成成功。
- **不要替用户写默认值。** `args`/`env`/`cwd`/`toolCallTimeoutMs`/`failOnStartupError`/`maxInstructionBytes` 都有官方默认值，用户没填就不写（`maxInstructionBytes` 等于 32768、`failOnStartupError === false` 时也要省略）。
- **`serverName` 全局唯一**：它决定 `mcp__<serverName>__<tool>`。编辑自己时要通过 `originalServerName` 排除自己，否则改不动自己的名称。
- **生效语义要如实说**：新增/编辑/删除改的是 profile patch，DSH Loader 不热重载 → 必须返回 `restartRequired: true`；只有 `pluginManager.setPluginEnabled` 那条路径才是 `applied`。不要为了让界面"看起来成功"而谎报。
- **profile 定位不能只看 `--profile`。** 桌面端把 profile 目录作为位置参数传进来（`dsh-desktop-host ... <profileDir> <runtime...>`），要看 argv 里真实存在的目录，并用 live patch id 做指纹兜底。
- 客户端 bundle **只允许** `require('react')`；测试里有一条断言盯着这一点。

## Build / verify

```powershell
npm run check   # node --check × 6
npm test        # node --test test/*.test.js（42+ 用例，无需 node_modules）
```

测试不联网、不写用户的真实 profile：`test/host.test.js` 用 mock ctx + `os.tmpdir()` 里的临时 profile；`test/real-profile.test.js` 对真实 `cordis.patch.yml` **只读**（做一次"编辑后删除"的内存模拟，不落盘）。

## Running / testing（人工）

装到 profile 后必须**重启 DSH** 才会加载插件条目：

```powershell
dsh plugin --profile desktop add "D:\dsh插件\dsh-mcp-manager"
```

重启后：设置 → MCP 服务器。排错先跑 `node tools/inspect-patch.js`，再看 `GET /mcp-manager/state`。
