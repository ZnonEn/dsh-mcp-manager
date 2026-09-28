# dsh-mcp-manager

**在 DSH 桌面端的设置页里管理 MCP 服务器**：列表、新增、编辑、删除、启用/停用，并显示每个服务器的**真实运行状态** —— 不用再手改 `cordis.patch.yml`。

> A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that manages MCP servers from a Settings page — list / add / edit / remove / enable / disable, with live runtime status. Zero dependencies.

![license](https://img.shields.io/badge/license-MIT-green)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A520-informational)

装好后设置页里会多出一页：**设置 → MCP 服务器**（`settings.section`，order 12，排在「模型」与「插件」之间）。

## 为什么需要它

MCP 服务器唯一的声明位置是 profile 目录里的 `cordis.patch.yml`。手改它有三个坑：

1. **条目形状容易写错** —— 它必须是一条 `- insert:` 块里的 `name: '@deepseek-ai/dsh-mcp-client'` 条目，`serverName` 还有字符集和唯一性要求（它决定 `mcp__<名称>__<工具>` 前缀）。
2. **改完不知道有没有生效** —— 文件写对了不代表服务器起来了。
3. **写坏了 DSH 会起不来** —— DSH 对无法解析的 profile patch 是启动期硬失败。

这个插件把三件事都接管了：按官方 schema 校验配置、写完实测探测运行状态、写盘前后自检并在失败时整份回滚。

## 功能

- **列表**：读出当前 profile 的 `cordis.patch.yml` 里所有 `@deepseek-ai/dsh-mcp-client` 条目，含传输方式、command/url、环境变量、超时等关键字段摘要。
- **运行状态**：合并 `pluginManager.listPlugins()` 的实测结果，显示 `运行中 / 加载中 / 已停用 / 加载失败 / 待重启生效`，不是靠猜。
- **新增**：表单填 `serverName`、传输方式（stdio / streamable-http），stdio 填 command/args/env/cwd，http 填 url/请求头；高级项可配调用超时、启动失败策略、重连参数。
- **编辑**：条目 ID 可改（改 ID 会重建条目并清理旧行，不留孤儿）；`serverName` 与自己同名可以通过，与别人冲突会被拒绝。
- **删除**：二次确认；删掉最后一个条目时，`- insert:` 块会被一并清理，或把新建 profile 的 `[]` 还原回去。
- **启用/停用**：条目已在运行树里时走官方 `pluginManager.setPluginEnabled`，**立即生效**；停用状态写进 profile patch 的顶层覆盖项（`- id: <条目id>` + `disabled: true`），重启后依然有效。
- **查看配置文件**：设置页内直接看 `cordis.patch.yml` 原文（只读）。
- **零依赖**：host 半边只用 Node 内置模块 + 自带的最小 YAML 读写实现，浏览器半边只有一个手写 bundle（只 `require('react')`）。

## 安装

### 方式 A：命令行（任意 profile，推荐）

```sh
dsh plugin add github:ZnonEn/dsh-mcp-manager
# 或固定版本
dsh plugin add github:ZnonEn/dsh-mcp-manager#v0.1.0
```

装完重启 DSH 即可（bundle 插件要下一次启动才加载）。

### 方式 B：DSH 桌面端（设置 → 插件）

桌面端的 profile 由桌面应用**独占管理**，命令行会直接拒绝：

```
$ dsh plugin --profile desktop add github:ZnonEn/dsh-mcp-manager
error: profile "desktop" is managed exclusively by the Electron application
```

所以要用桌面端自己的插件页：把仓库 clone 到本地，然后在 **设置 → 插件** 的安装入口粘贴**该目录的绝对路径**，装完**完全退出并重启 DSH**。

### 卸载

```sh
dsh plugin remove dsh-mcp-manager
```

或在桌面端 **设置 → 插件** 里卸载。卸载只移除插件本身，不会动你已有的 MCP 服务器配置。

## 使用

打开 **设置 → MCP 服务器**：

| 操作 | 说明 |
| --- | --- |
| 刷新 | 重新读磁盘上的 `cordis.patch.yml` 并刷新运行状态 |
| 新增服务器 | 展开表单，保存后立即写盘 |
| 编辑 / 删除 | 在每张服务器卡片上 |
| 启用 / 停用 | 运行中的条目走 `pluginManager`，立即生效 |
| 查看配置文件 | 看当前读写的文件原文，以及插件定位到的是哪个 profile |

**状态是怎么来的**

| 界面显示 | 含义 |
| --- | --- |
| 运行中 | 条目在运行树里且 fiber 已 active |
| 加载中 | 条目已进运行树，但还没就绪 |
| 已停用 | 文件里标记停用（条目自身或顶层覆盖项） |
| 加载失败 | 条目在运行树里但加载报错（常见：command 路径不对、握手超时） |
| 待重启生效 | 文件里有这个条目，但运行树里还没有 —— 等热加载，或重启 DSH |
| 已在文件中、未进入运行树 | 有告警条，通常等几秒热加载即可 |

## 生效规则

| 操作 | 生效方式 |
| --- | --- |
| 新增 / 编辑 / 删除 | 改写 profile 的 `cordis.patch.yml`。DSH 会监视该文件并**自动热加载**（实测约 2–6 秒）；写盘后插件会实测探测，界面如实显示「已生效」还是「待重启生效」 |
| 启用 / 停用（已在运行树） | 走 `pluginManager.setPluginEnabled`，**立即生效** |
| 你自己在外部改这个文件 | 同样会被 DSH 热加载；插件在下次读文件时（打开页面 / 点刷新）就能看到 |

## 支持的配置字段

字段与默认值对齐 `@deepseek-ai/dsh-mcp-client` 的官方 schema：

| 字段 | 说明 |
| --- | --- |
| `serverName` | 必填。`[A-Za-z0-9_-]{1,32}`，profile 内唯一，决定工具名前缀 `mcp__<serverName>__<tool>` |
| `transport` | `stdio`（默认）或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | stdio 用；`command` 必填 |
| `url` / `headers` | streamable-http 用；必须是 http(s) URL |
| `toolCallTimeoutMs` | 单次工具调用超时（默认 60000） |
| `failOnStartupError` | 启动失败是否让所在 fiber 失败（默认 false） |
| `maxInstructionBytes` | 指令截断上限（默认 32768） |
| `reconnect` | `{ enabled, initialDelayMs, maxDelayMs, maxAttempts }`，按官方边界校验（`[1, 2147483647]`，`maxAttempts ≥ 1` 整数） |

**没填的字段不会写进文件** —— 交给 `dsh-mcp-client` 用它自己的默认值，避免把默认值固化进你的配置。

## 安全与可靠性

- **只改目标条目**：所有写操作都在**行级**完成（替换/插入/删除该条目的行范围），文件里其它插件、`!!js` 表达式、注释一律逐字节保留。
- **写前自动备份**：`cordis.patch.yml.bak-mcp-manager-<时间戳>`，保留最近 10 份。
- **原子写**：写临时文件后 `rename`，不会出现写了一半的文件。
- **写后结构自检 + 失败整份回滚**：确认目标条目落在合法的 `- insert:` 块里、缩进正确；任何一步失败就把原文件恢复回去，宁可「什么都没改」也不留一个坏文件。
- **读不懂的结构不猜**：遇到块标量（`|` `>`）、锚点、标签这类本实现读不懂的 YAML 特性，会拒绝解析该条目并在界面上标红，而不是猜完写回去。
- **不碰别人的层**：只管理当前 profile 的 `cordis.patch.yml`，其它 profile 层提供的 MCP 条目不会被改写。

## 已知限制

- **组定向插入里的条目不会被列出**：写在 `- id: <group>` 内部 `insert:` 里的 MCP 条目（官方 `applyEntryPatches` 支持的一种合法结构）不会出现在列表里，也不会被编辑 —— 这是刻意的，避免把生成的行写到错误缩进上、写出非法 YAML。它们照样会被 DSH 加载运行。
- **页面不主动轮询**：停留在该页时，外部对配置文件的改动不会自动跳出来；点「刷新」或重新打开即可（保存/启停/删除之后插件会自己在 4 秒后回读一次，用来如实显示是否生效）。
- **只支持一个 YAML 子集**：本实现的解析器覆盖 profile patch 的常见写法，不覆盖完整 YAML 规范（见上）。
- **只管理 profile patch 这一层**：不处理 `cordis.yml` 或其它 profile 层里的 MCP 条目。

## 排错

先点「查看配置文件」确认插件定位到的 profile 与文件路径对不对，然后按顺序查：

1. **设置页没有「MCP 服务器」**：插件没装到当前 profile，或装完没重启 DSH。
2. **提示「未定位到 profile 目录」**：用环境变量显式指定，然后重启 DSH：

   ```powershell
   setx DSH_MCP_MANAGER_PROFILE "C:\Users\<你>\.dsh\profiles\desktop"
   ```

3. **看 host 半边到底读到了什么**（只读，不改文件）：

   ```sh
   node tools/inspect-patch.js
   node tools/inspect-patch.js "C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml"
   ```

4. **从 HTTP 接口直接看**：插件注册了 `/mcp-manager/*` 路由，见下。

### 关于 profile 定位

DSH 桌面端由 `dsh-desktop-host` 启动 harness，命令行里**没有** `--profile`，而是把 profile 目录作为位置参数传进去；命令行启动（`dsh --profile web`）又只有 `--profile`；而进程环境里的 `DSH_PROFILE_DIR` 可能是别的 profile 留下的旧值（实测：用 `--profile xxx` 起的实例里，该变量仍指向 `desktop`）。所以定位顺序是：

1. 环境变量 `DSH_MCP_MANAGER_PROFILE`（显式覆盖）
2. `process.argv` 里真实存在的 profile 目录（桌面端的位置参数）
3. `process.argv` 里的 `--profile <name>` / `--profile=<name>`
4. 环境变量 `DSH_PROFILE_DIR`
5. 用 live 的 patch id 与 `$DSH_HOME/profiles/*/cordis.patch.yml` 做指纹匹配
6. `$DSH_HOME/profiles/desktop` → `web`

这正是为了避开「只认一种来源 → 回落到错误 profile → 读到并写坏另一份配置」的坑。

## HTTP 接口

给二次开发/脚本化用（都返回 JSON）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/mcp-manager/state` | 完整状态：profile 信息、服务器列表、运行状态、告警 |
| GET | `/mcp-manager/raw` | `cordis.patch.yml` 原文（只读） |
| POST | `/mcp-manager/save` | 新增/编辑，body `{ server, originalId? }` |
| POST | `/mcp-manager/remove` | 删除，body `{ id }` |
| POST | `/mcp-manager/toggle` | 启用/停用，body `{ id, enabled }` |
| POST | `/mcp-manager/refresh` | 重新定位 profile 并回报路径 |

## 工作原理

插件分两半，都是 DSH 的标准形态：

- **host 半边**（`src/index.js`，Cordis 插件，`inject: ['webServer']`）：读写 profile 的 `cordis.patch.yml`、调用 `pluginManager` 拿运行状态、注册上面 6 条 HTTP 路由。
- **client 半边**（`client/bundle.js`，手写 ES5 bundle）：按 client-modules 协议注册到 `settings.section`，画出设置页；所有数据都走 host 的 HTTP 路由，浏览器不直接碰文件系统。

可选配置（插件 config）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `moduleName` | `@deepseek-ai/dsh-mcp-client` | 认哪个包名是「MCP 客户端」条目 |
| `setPluginEnabledTimeoutMs` | `8000` | 调 `pluginManager.setPluginEnabled` 的超时兜底（官方实现会写盘后 reload，条目卡住时可能长时间不返回） |

## 目录结构

```
dsh-mcp-manager/
├─ src/
│  ├─ index.js        host 半边：Cordis 插件 + /mcp-manager/* HTTP 路由
│  ├─ patch-file.js   cordis.patch.yml 的行级扫描与增删改
│  ├─ yaml-mini.js    最小 YAML 读写（保留注释，拒绝不支持的语法）
│  ├─ validate.js     表单校验与配置规范化
│  └─ locate.js       profile 目录定位（argv / env / 指纹）
├─ client/
│  └─ bundle.js       浏览器半边：设置页「MCP 服务器」（ES5 手写 bundle）
├─ test/              node:test 测试（64 个用例，含真实 profile 只读验证）
├─ tools/
│  └─ inspect-patch.js 排错工具：打印 patch 文件里每个条目的解析结果
├─ cordis.patch.yml   安装到 profile 时插入的插件条目
└─ package.json
```

## 开发与测试

```sh
npm run check   # 六个文件的语法检查
npm test        # node:test，64 个用例，无需联网、不依赖 node_modules
```

测试覆盖：最小 YAML 解析/生成、patch 文件的行级编辑（注释保留、CRLF、幂等、空 profile 的 `[]` 展开、组定向插入不被误判）、表单校验与官方边界、profile 定位、host 全部 HTTP 路由的端到端行为（mock ctx + 真实临时文件）、客户端 bundle 的协议与注册参数，以及对本机真实 `cordis.patch.yml` 的**只读**验证。

此外做过真实 DSH 实例的端到端验证（临时 profile，验证后清理）：装进临时 profile → `--dump-config` 确认条目进入 host 组合 → 启动 DSH → `GET /mcp-manager/state` 正确读出条目 → `POST /save` 新增且 `--dump-config` 仍能解析 → `POST /toggle` 走 pluginManager → 重复 `serverName` 被拒 → `POST /remove` 后文件回到合法的空数组。

### 兼容性

配置字段按已安装的 `@deepseek-ai/dsh-mcp-client`（0.1.7-rc.2）的 schema 对齐。DSH 升级后若字段有变化，欢迎提 Pull Request（本仓库未开启 Issues）。

## 许可

MIT
