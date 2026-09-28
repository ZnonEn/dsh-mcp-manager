# dsh-mcp-manager

在 **DSH 桌面端的设置页**里管理 MCP 服务器：列表、新增、编辑、删除、启用/停用，并显示每个服务器的运行状态。不用再手改 `cordis.patch.yml`。

- 设置页位置：**设置 → MCP 服务器**（`settings.section`，order 12，排在「模型」与「插件」之间）
- 零依赖：host 半边只用 Node 内置模块 + 自带的最小 YAML 读写实现，不引第三方 YAML 库
- 不破坏配置：只改你要动的那一个条目，其余内容（包括你自己写的注释）逐字节保留

## 功能

| 能力 | 说明 |
| --- | --- |
| 列出服务器 | 读取当前 profile 的 `cordis.patch.yml` 里所有 `@deepseek-ai/dsh-mcp-client` 条目 |
| 运行状态 | 合并 `pluginManager.listPlugins()`，显示 运行中 / 已停用 / 待重启生效 / 加载失败 |
| 新增 | 表单填写 serverName、传输方式、命令/参数/环境变量/工作目录，或 URL/请求头 |
| 编辑 | 条目 ID 可改（改 ID 会重建条目，不会留下孤儿）；serverName 重复会被拒绝 |
| 删除 | 带二次确认；删除后该 `- insert:` 块变空时连块一起清理 |
| 启用/停用 | 条目已在运行中时走官方 `pluginManager.setPluginEnabled`，**立即生效** |
| 查看配置文件 | 设置页内直接看 `cordis.patch.yml` 原文（只读） |

## 安装

```powershell
dsh plugin --profile desktop add "D:\dsh插件\dsh-mcp-manager"
```

然后**完全退出并重启 DSH 桌面端**（新增的插件条目本身也属于 profile patch，同样要重启才加载）。

> 桌面端用的 profile 是 `desktop`（对应 `%USERPROFILE%\.dsh\profiles\desktop`）。
> 装完可以打开 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 确认多了一条 `- id: mcp-manager`。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-mcp-manager
```

## 生效规则（重要）

| 操作 | 生效方式 |
| --- | --- |
| 新增 / 编辑 / 删除服务器 | 改写 profile 的 `cordis.patch.yml` → **重启 DSH 后生效** |
| 启用 / 停用（该条目当前已在运行） | 走 `pluginManager.setPluginEnabled` → **立即生效** |

原因是 DSH 的 Loader 不会热重载 profile patch（`cordis.patch.yml` 属于启动期配置），而 MCP 服务器条目正是 profile patch 的一部分。界面会如实提示「待重启生效」，不会假装已经连上。

## 安全与可靠性

- **只改目标条目**：写操作都在行级完成（替换/插入/删除条目的行范围），文件里其它插件、`!!js` 表达式、注释一律不动。
- **写入前自动备份**：`cordis.patch.yml.bak-mcp-manager-<时间戳>`，保留最近 10 份。
- **原子写 + 回读校验**：先写临时文件再 `rename`，随后回读确认目标条目真的在文件里，读不回就报错。
- **校验**：`serverName` 必须是 `[A-Za-z0-9_-]{1,32}` 且在 profile 内唯一（它决定 `mcp__<名称>__<工具>` 前缀）；条目 ID 不能与任何已有条目（含顶层 `- id:`）冲突；stdio 必须有 command，streamable-http 必须有 http(s) URL；超时/重连参数做范围校验。
- **不写默认值**：用户没填的字段不会写进文件，交给 `@deepseek-ai/dsh-mcp-client` 用它自己的官方默认值（`args: []`、`env: {}`、`toolCallTimeoutMs` 默认、`failOnStartupError: false` 等）。
- **不支持的 YAML 特性直接报错**：遇到块标量 `|` `>`、锚点、标签等本实现读不懂的结构会拒绝解析该条目并在界面上标红，而不是猜测后写坏文件。

## 排错

设置页里点「查看配置文件」可以看到当前读写的文件；显示的数据不对时，按顺序查：

1. **设置页没有「MCP 服务器」**：插件没装到当前 profile，或装完没重启。
2. **提示"未定位到 profile 目录"**：用环境变量显式指定，然后重启 DSH：

   ```powershell
   setx DSH_MCP_MANAGER_PROFILE "C:\Users\<你>\.dsh\profiles\desktop"
   ```

3. **看 host 半边到底读到了什么**（只读，不改文件）：

   ```powershell
   node tools/inspect-patch.js
   node tools/inspect-patch.js "C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml"
   ```

4. **从 HTTP 接口直接看**：`GET /mcp-manager/state`（另有 `/raw`、`/refresh`；写操作 `/save`、`/remove`、`/toggle` 都是 POST + JSON）。

### 关于 profile 定位

DSH 桌面端由 `dsh-desktop-host` 启动 harness，命令行里**没有** `--profile`，而是把 profile 目录作为位置参数传进去。本项目按这个事实定位，顺序为：

1. 环境变量 `DSH_MCP_MANAGER_PROFILE`（显式覆盖）
2. `process.argv` 里真实存在的 profile 目录（含 `cordis.patch.yml` / `cordis.yml` 的目录）
3. 环境变量 `DSH_PROFILE_DIR`
4. 用 live 的 patch id 与 `$DSH_HOME/profiles/*/cordis.patch.yml` 做指纹匹配
5. `$DSH_HOME/profiles/desktop` → `web`

（这正是为了避开"只认 `--profile` 参数、于是回落到错误 profile、读到另一份配置"的坑。）

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
├─ test/              node:test 测试（含真实 profile 只读验证）
├─ tools/
│  └─ inspect-patch.js 排错工具：打印 patch 文件里每个条目的解析结果
├─ cordis.patch.yml   安装到 profile 时插入的插件条目
└─ package.json
```

## 开发与测试

```powershell
npm run check   # 六个文件的语法检查
npm test        # node:test，无需联网、不依赖 node_modules
```

测试覆盖：最小 YAML 解析/生成、patch 文件的行级编辑（含注释保留、CRLF、幂等）、表单校验、profile 定位、host 全部 HTTP 路由的端到端行为（用 mock ctx + 真实临时文件）、客户端 bundle 的协议与注册参数，以及对本机真实 `cordis.patch.yml` 的只读验证。

## 许可

MIT
