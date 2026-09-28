'use strict'

/**
 * dsh-mcp-manager —— Host 半边。
 *
 * 目标：在 DSH 设置页里直接管理「MCP 服务器」，不需要手改
 * `<profile>/cordis.patch.yml`。
 *
 * 数据源与写入路径（全部来自 harness 自身的契约，不是猜测）：
 *  · 文件事实：`<profile>/cordis.patch.yml` 的 `- insert:` 里
 *    `name: '@deepseek-ai/dsh-mcp-client'` 的条目 —— 这是 MCP 服务器唯一的
 *    声明位置；本插件只做行级增删改，其它内容与注释原样保留。
 *  · live 事实：`ctx.get('pluginManager').listPlugins()` 给出每个条目的
 *    entryId / enabled / fiberPhase，用来显示「运行中 / 已停止 / 加载失败 /
 *    待重启」；`ctx.get('configEditor').entries()` 提供 patch id 指纹，用于
 *    在 argv 定位失败时确认 profile 目录。
 *  · 热禁用：`pluginManager.setPluginEnabled(entryId, enabled)`（官方路径，
 *    立即生效）；没有 pluginManager 时退化为写 `disabled:` 键（重启生效）。
 *
 * 注意：新增/修改/删除条目写的是**配置文件**，DSH 的 Loader 不会热重载
 * profile patch，所以这三类操作需要重启 DSH 才生效 —— 接口把这件事如实
 * 返回给 UI（`restartRequired`），不假装已经生效。
 */

const fs = require('node:fs')
const path = require('node:path')

const patchFile = require('./patch-file.js')
const { validateServer } = require('./validate.js')
const { locateProfileDir } = require('./locate.js')

const PATCH_FILENAME = 'cordis.patch.yml'
const ROUTE_PREFIX = '/mcp-manager'
const MAX_BODY_BYTES = 512 * 1024
const BACKUP_KEEP = 10

function messageOf(error) {
  return String((error && error.message) || error)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 从 pluginManager.listPlugins() 的结果里挑出 MCP 客户端条目。 */
function pickLiveServers(plugins, moduleName) {
  const out = []
  for (const raw of plugins || []) {
    if (!raw || typeof raw !== 'object') continue
    const mod = typeof raw.moduleName === 'string' ? raw.moduleName : ''
    if (mod !== moduleName && !mod.endsWith('dsh-mcp-client')) continue
    out.push({
      entryId: raw.entryId === undefined ? null : String(raw.entryId),
      patchId: raw.patchId === undefined || raw.patchId === null ? null : String(raw.patchId),
      moduleName: mod,
      enabled: raw.enabled !== false,
      phase: raw.fiberPhase === undefined ? null : raw.fiberPhase,
      metaTitle: raw.meta && raw.meta.title ? String(raw.meta.title) : null,
    })
  }
  return out
}

/** 把 live 条目匹配到文件条目的 id 上（patchId / entryId 的前后缀都可能带前缀）。 */
function matchLive(liveServers, entryId) {
  if (!entryId) return null
  for (const live of liveServers) {
    if (live.patchId === entryId || live.entryId === entryId) return live
  }
  for (const live of liveServers) {
    const p = live.patchId || ''
    const e = live.entryId || ''
    if (p.endsWith(`.${entryId}`) || p.endsWith(`/${entryId}`) || p.endsWith(`:${entryId}`)) return live
    if (e.endsWith(`.${entryId}`) || e.endsWith(`/${entryId}`)) return live
  }
  return null
}

/** 概要信息（列表卡片用），避免把完整 env 值铺到列表里。 */
function summarize(config) {
  const cfg = config || {}
  return {
    serverName: cfg.serverName === undefined ? null : String(cfg.serverName),
    transport: cfg.transport === undefined ? null : String(cfg.transport),
    command: cfg.command === undefined ? null : String(cfg.command),
    argsCount: Array.isArray(cfg.args) ? cfg.args.length : 0,
    envKeys: cfg.env && typeof cfg.env === 'object' ? Object.keys(cfg.env) : [],
    cwd: cfg.cwd ? String(cfg.cwd) : null,
    url: cfg.url ? String(cfg.url) : null,
    headerKeys: cfg.headers && typeof cfg.headers === 'object' ? Object.keys(cfg.headers) : [],
    toolCallTimeoutMs: cfg.toolCallTimeoutMs === undefined ? null : cfg.toolCallTimeoutMs,
    failOnStartupError: cfg.failOnStartupError === true,
    reconnect: cfg.reconnect && typeof cfg.reconnect === 'object' ? cfg.reconnect : null,
  }
}

module.exports = {
  name: 'mcp-manager',
  inject: ['webServer'],

  apply(ctx, config) {
    const options = config && typeof config === 'object' ? config : {}
    const moduleName = typeof options.moduleName === 'string' && options.moduleName.trim() !== ''
      ? options.moduleName.trim()
      : patchFile.MCP_CLIENT_MODULE
    const logger = ctx.logger

    let profileCache = null
    let writeChain = Promise.resolve()

    function log(level, text) {
      if (!logger) return
      const fn = typeof logger[level] === 'function' ? logger[level] : null
      if (fn) fn.call(logger, text)
    }

    // ── profile 定位 ──────────────────────────────────────────────────────
    function livePatchIds() {
      const ids = []
      const editor = ctx.get('configEditor')
      if (editor && typeof editor.entries === 'function') {
        try {
          for (const entry of editor.entries() || []) {
            if (!entry) continue
            const candidates = [entry.patchId, entry.id, entry.options && entry.options.id]
            for (const c of candidates) if (typeof c === 'string' && c !== '') ids.push(c)
          }
        } catch (e) {
          log('warn', `[mcp-manager] 读取 configEditor.entries() 失败：${messageOf(e)}`)
        }
      }
      return ids
    }

    function resolveProfile(force) {
      if (profileCache && !force) return profileCache
      const located = locateProfileDir({ livePatchIds: livePatchIds() })
      const file = located.dir ? path.join(located.dir, PATCH_FILENAME) : null
      let exists = false
      let writable = false
      if (file) {
        try {
          exists = fs.existsSync(file)
          if (exists) fs.accessSync(file, fs.constants.W_OK)
          writable = exists
        } catch {
          writable = false
        }
      }
      profileCache = {
        dir: located.dir,
        source: located.source,
        file,
        exists,
        writable,
        candidates: located.candidates,
        warnings: located.warnings.slice(),
      }
      if (!located.dir) {
        profileCache.warnings.push('没能定位到 profile 目录，请用环境变量 DSH_MCP_MANAGER_PROFILE 指定')
      }
      return profileCache
    }

    function readPatchText() {
      const profile = resolveProfile(false)
      if (!profile.file || !profile.exists) {
        throw new Error(`找不到 profile 的 ${PATCH_FILENAME}（profile 目录：${profile.dir || '未定位到'}）`)
      }
      return fs.readFileSync(profile.file, 'utf8')
    }

    function readServers(text) {
      return patchFile.listMcpEntries(text, moduleName).map((entry) => ({
        ...entry,
        summary: summarize(entry.config),
      }))
    }

    // ── 写盘：备份 + 原子写 + 回读校验 ─────────────────────────────────────
    function backup(file) {
      try {
        const dest = `${file}.bak-mcp-manager-${timestamp()}`
        fs.copyFileSync(file, dest)
        const dir = path.dirname(file)
        const base = path.basename(file)
        const olds = fs.readdirSync(dir)
          .filter((n) => n.startsWith(`${base}.bak-mcp-manager-`))
          .sort()
        while (olds.length > BACKUP_KEEP) {
          const victim = olds.shift()
          try { fs.unlinkSync(path.join(dir, victim)) } catch { /* ignore */ }
        }
        return dest
      } catch (e) {
        log('warn', `[mcp-manager] 备份失败（继续写入）：${messageOf(e)}`)
        return null
      }
    }

    function writePatchText(nextText, expectEntryId) {
      const profile = resolveProfile(false)
      const file = profile.file
      backup(file)
      const tmp = `${file}.tmp-mcp-manager`
      fs.writeFileSync(tmp, nextText, 'utf8')
      fs.renameSync(tmp, file)
      // 回读校验：确认落盘内容里能读回目标条目，读不回就当作写失败抛错
      const verifyText = fs.readFileSync(file, 'utf8')
      const entries = patchFile.listMcpEntries(verifyText, moduleName)
      if (expectEntryId && !entries.some((e) => e.id === expectEntryId)) {
        throw new Error(`写入后回读校验失败：文件里没有条目 ${expectEntryId}`)
      }
      for (const e of entries) {
        if (e.parseError) {
          log('warn', `[mcp-manager] 条目 ${e.id} 写入后无法解析：${e.parseError}`)
        }
      }
      return { file, entries }
    }

    function withLock(fn) {
      const run = writeChain.then(fn, fn)
      writeChain = run.then(() => undefined, () => undefined)
      return run
    }

    // ── 状态组装 ──────────────────────────────────────────────────────────
    async function buildState() {
      const profile = resolveProfile(false)
      const warnings = profile.warnings.slice()
      let text = null
      let fileError = null
      try {
        text = readPatchText()
      } catch (e) {
        fileError = messageOf(e)
      }

      let liveServers = []
      const manager = ctx.get('pluginManager')
      let liveAvailable = false
      if (manager && typeof manager.listPlugins === 'function') {
        try {
          liveServers = pickLiveServers(await manager.listPlugins(), moduleName)
          liveAvailable = true
        } catch (e) {
          warnings.push(`读取插件运行状态失败：${messageOf(e)}`)
        }
      } else {
        warnings.push('当前 profile 没有 pluginManager 服务，运行状态不可用（配置读写不受影响）')
      }

      const servers = []
      if (text !== null) {
        for (const entry of readServers(text)) {
          const live = matchLive(liveServers, entry.id)
          let sync = 'pending-restart'
          if (entry.disabled) sync = 'disabled'
          if (live) {
            if (live.enabled === false) sync = 'stopped'
            else if (live.phase === 'failed') sync = 'failed'
            else if (live.phase === 'active') sync = 'live'
            else sync = 'loading'
          }
          servers.push({ ...entry, live, sync })
        }
        // 文件里没有、但 live 里存在的 MCP 条目（例如由其它 profile 层提供）
        for (const live of liveServers) {
          const hit = servers.some((s) => s.live && s.live.entryId === live.entryId)
          if (!hit) {
            servers.push({
              id: live.patchId || live.entryId,
              moduleName: live.moduleName,
              disabled: live.enabled === false,
              config: null,
              parseError: null,
              summary: summarize(null),
              live,
              sync: 'external',
              external: true,
            })
          }
        }
        servers.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      }

      return {
        ok: fileError === null,
        error: fileError,
        now: Date.now(),
        routePrefix: ROUTE_PREFIX,
        profile: {
          dir: profile.dir,
          source: profile.source,
          file: profile.file,
          exists: profile.exists,
          writable: profile.writable,
          candidates: profile.candidates,
        },
        moduleName,
        liveAvailable,
        servers,
        counts: {
          total: servers.filter((s) => !s.external).length,
          live: servers.filter((s) => s.sync === 'live').length,
          stopped: servers.filter((s) => s.sync === 'stopped' || s.sync === 'disabled').length,
          pending: servers.filter((s) => s.sync === 'pending-restart').length,
          failed: servers.filter((s) => s.sync === 'failed').length,
        },
        warnings,
      }
    }

    async function saveServer(body) {
      const raw = body && typeof body === 'object' ? body.server || body : null
      if (!raw || typeof raw !== 'object') throw new Error('缺少 server 数据')
      const originalId = typeof body.originalId === 'string' && body.originalId !== '' ? body.originalId : null

      const text = readPatchText()
      // id 查重覆盖 insert 条目与顶层 `- id:` 条目（同 id 会互相覆盖）
      const reservedIds = [...patchFile.collectEntryIds(text)]
      // serverName 必须全局唯一（它决定 mcp__<名称>__<工具> 前缀），编辑自己时排除自己
      const existingServers = patchFile.listMcpEntries(text, moduleName)
      const originalEntry = originalId ? existingServers.find((e) => e.id === originalId) : null
      const originalServerName = originalEntry && originalEntry.config && typeof originalEntry.config.serverName === 'string'
        ? originalEntry.config.serverName
        : ''
      const reservedServerNames = existingServers
        .filter((e) => e.id !== originalId)
        .map((e) => e.config && typeof e.config.serverName === 'string' ? e.config.serverName : null)
        .filter(Boolean)
      const result = validateServer(raw, { reservedIds, originalId, reservedServerNames, originalServerName })
      if (!result.ok) {
        const err = new Error('配置校验未通过')
        err.details = result.errors
        err.statusCode = 400
        throw err
      }
      const { id, config: serverConfig } = result.value

      // 改 id：先删旧条目再按新 id 写入，避免留下孤儿条目
      let working = text
      if (originalId && originalId !== id) {
        const removed = patchFile.removeEntry(working, originalId)
        if (!removed.removed) throw new Error(`找不到要修改的条目 ${originalId}`)
        working = removed.text
      }
      const upserted = patchFile.upsertEntry(working, { id, moduleName, config: serverConfig })
      const written = writePatchText(upserted.text, id)
      return {
        ok: true,
        action: upserted.action,
        id,
        file: written.file,
        restartRequired: true,
        note: '配置已写入 profile 文件；DSH 的 Loader 不会热重载 profile patch，重启 DSH 后该服务器才会连接。',
      }
    }

    async function removeServer(body) {
      const id = body && typeof body.id === 'string' ? body.id : ''
      if (id === '') throw new Error('缺少 id')
      const text = readPatchText()
      const removed = patchFile.removeEntry(text, id)
      if (!removed.removed) {
        const err = new Error(`找不到条目 ${id}`)
        err.statusCode = 404
        throw err
      }
      const remaining = patchFile.listMcpEntries(removed.text, moduleName)
      const written = writePatchText(removed.text, remaining.length > 0 ? remaining[0].id : null)
      return {
        ok: true,
        id,
        file: written.file,
        restartRequired: true,
        note: '条目已从 profile 文件删除；已连接的服务会一直运行到 DSH 重启。',
      }
    }

    async function toggleServer(body) {
      const id = body && typeof body.id === 'string' ? body.id : ''
      const enabled = !(body && body.enabled === false)
      if (id === '') throw new Error('缺少 id')

      const text = readPatchText()
      const entry = patchFile.listMcpEntries(text, moduleName).find((e) => e.id === id)
      if (!entry) {
        const err = new Error(`找不到条目 ${id}`)
        err.statusCode = 404
        throw err
      }

      const manager = ctx.get('pluginManager')
      let liveServers = []
      if (manager && typeof manager.listPlugins === 'function') {
        try { liveServers = pickLiveServers(await manager.listPlugins(), moduleName) } catch { /* ignore */ }
      }
      const live = matchLive(liveServers, id)

      if (live && manager && typeof manager.setPluginEnabled === 'function') {
        const change = await manager.setPluginEnabled(live.entryId, enabled)
        // 顺带清掉文件里可能残留的 disabled 键，避免两套状态互相打架
        const cleaned = patchFile.setEntryDisabled(text, id, !enabled && change && change.application === 'restart-required')
        if (cleaned.changed) writePatchText(cleaned.text, id)
        return {
          ok: true,
          id,
          enabled,
          applied: change ? change.application : null,
          restartRequired: !!change && change.application === 'restart-required',
          note: change && change.application === 'applied'
            ? '已通过 pluginManager 立即生效。'
            : '已写入启用状态；重启 DSH 后生效。',
        }
      }

      const toggled = patchFile.setEntryDisabled(text, id, !enabled)
      if (!toggled.changed) {
        return { ok: true, id, enabled, applied: 'noop', restartRequired: false, note: '状态未发生变化。' }
      }
      writePatchText(toggled.text, id)
      return {
        ok: true,
        id,
        enabled,
        applied: 'restart-required',
        restartRequired: true,
        note: '已写入 profile 文件的 disabled 键；重启 DSH 后生效。',
      }
    }

    // ── 路由注册 ──────────────────────────────────────────────────────────
    const routes = {
      [`${ROUTE_PREFIX}/state`]: async () => buildState(),
      [`${ROUTE_PREFIX}/raw`]: async () => {
        const profile = resolveProfile(false)
        return {
          ok: true,
          file: profile.file,
          exists: profile.exists,
          text: profile.exists ? readPatchText() : '',
        }
      },
      [`${ROUTE_PREFIX}/save`]: async (body) => withLock(() => saveServer(body)),
      [`${ROUTE_PREFIX}/remove`]: async (body) => withLock(() => removeServer(body)),
      [`${ROUTE_PREFIX}/toggle`]: async (body) => withLock(() => toggleServer(body)),
      [`${ROUTE_PREFIX}/refresh`]: async () => {
        const profile = resolveProfile(true)
        return { ok: true, profile: { dir: profile.dir, source: profile.source, file: profile.file } }
      },
    }

    for (const [routePath, handler] of Object.entries(routes)) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          try {
            let body = null
            if (req.method === 'POST') {
              const text = await readBody(req)
              body = text.trim() === '' ? {} : JSON.parse(text)
            }
            const payload = await handler(body)
            sendJson(res, payload && payload.statusCode ? payload.statusCode : 200, payload && payload.ok === false && !payload.error ? { ...payload, ok: true } : payload)
          } catch (e) {
            const status = e && e.statusCode ? e.statusCode : 500
            sendJson(res, status, {
              ok: false,
              error: messageOf(e),
              details: e && Array.isArray(e.details) ? e.details : undefined,
            })
          }
        },
      }), `mcp-manager: route ${routePath}`)
    }

    // 启动时做一次定位并记日志，便于排查「读到了哪个 profile」
    try {
      const profile = resolveProfile(false)
      log('info', `[mcp-manager] profile=${profile.dir || '未定位'}（来源：${profile.source}），配置文件：${profile.file || '-'}`)
    } catch (e) {
      log('warn', `[mcp-manager] 初始化定位失败：${messageOf(e)}`)
    }
  },
}
