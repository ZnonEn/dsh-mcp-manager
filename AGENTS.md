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
- **生效语义要如实说。** 新增/编辑/删除改的是 profile patch：DSH（实测桌面端与 CLI 都是）通常会自动热加载这个文件，所以写盘后必须用 `confirmLive()` 实测探测，再决定返回 `restartRequired` 还是"已生效" —— 既不要一律谎报"要重启"，也不要假装已经生效。
- **新建 profile 的 `cordis.patch.yml` 内容就是一个 `[]`**（顶层 flow 空数组）。往里追加 `- insert:` 会产生「同一文档里既有 flow 序列又有 block 序列」的非法 YAML，必须**原地展开那一行**；删掉最后一个条目后要把 `[]` 补回去。`parseYamlSubset` 也要能解析顶层 flow 集合（测试里有对应用例）。
- **profile 定位不能只看一种来源。** 桌面端把 profile 目录作为位置参数传进来（`dsh-desktop-host ... <profileDir> <runtime...>`）；CLI 用 `--profile <name>`；而进程环境里的 `DSH_PROFILE_DIR` 可能是别的 profile 留下的旧值（实测被它带偏过）。三处都要认，并用 live patch id 指纹兜底。
- 客户端 bundle **只允许** `require('react')`；测试里有一条断言盯着这一点。

## Build / verify

```powershell
npm run check   # node --check × 6
npm test        # node --test test/*.test.js（52 个用例，无需 node_modules）
```

测试不联网、不写用户的真实 profile：`test/host.test.js` 用 mock ctx + `os.tmpdir()` 里的临时 profile；`test/real-profile.test.js` 对真实 `cordis.patch.yml` **只读**（做一次"编辑后删除"的内存模拟，不落盘）。

## Running / testing（人工）

桌面端 profile 不能用命令行装（`dsh plugin --profile desktop` 会被 Electron 独占保护拒绝），要在**设置 → 插件**里粘贴本目录路径安装，然后重启 DSH。

想验证 host 半边而不碰桌面端，可以起一个临时 profile：

```powershell
dsh --profile mcpman-smoke --from-default-profile web --dump-config   # 建临时 profile
dsh plugin --profile mcpman-smoke add "D:\dsh插件\dsh-mcp-manager"    # 装进去（会自动注册 bundle 层）
dsh --profile mcpman-smoke --no-open --port 18999                     # 起服务
curl http://127.0.0.1:18999/mcp-manager/state                         # 直接打插件路由
```

用完删掉 `%USERPROFILE%\.dsh\profiles\mcpman-smoke` 即可。排错先跑 `node tools/inspect-patch.js`。
