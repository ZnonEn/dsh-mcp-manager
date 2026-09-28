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
 * 注意：新增/修改/删除条目写的是**配置文件**。DSH 会监视该文件并热加载
 * （实测约 2–6 秒），但时序不保证；所以每次写盘后都用 `probeLiveAfterWrite`
 * 实测探测 fiber 状态，把「已生效 / 加载失败 / 无法确认 / 待生效」如实返回给 UI，
 * 既不谎报已生效，也不一律要求重启。写盘前自动备份，写后做结构自检，不通过就整份回滚。
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
    /** pluginManager.setPluginEnabled 的等待上限（毫秒）；条目卡在 MCP 握手时会等很久。 */
    const mutateTimeoutMs = Number.isFinite(options.setPluginEnabledTimeoutMs)
      ? options.setPluginEnabledTimeoutMs
      : 8000

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
      const previous = fs.readFileSync(file, 'utf8')
      backup(file)
      const tmp = `${file}.tmp-mcp-manager`
      fs.writeFileSync(tmp, nextText, 'utf8')
      fs.renameSync(tmp, file)
      try {
        const verifyText = fs.readFileSync(file, 'utf8')
        // 结构自检：DSH 对无法解析的 profile patch 是**启动期硬失败**
        // （"must fail loud at boot, never be silently skipped"），
        // 所以"条目能读出来"远远不够 —— 必须确认它落在结构正确的独立 insert 块里。
        const safe = patchFile.assertSafePatch(verifyText, expectEntryId)
        if (!safe.ok) throw new Error(`写入后结构自检失败：${safe.problem}`)
        const entries = patchFile.listMcpEntries(verifyText, moduleName)
        if (expectEntryId && !entries.some((e) => e.id === expectEntryId)) {
          throw new Error(`写入后回读校验失败：文件里没有条目 ${expectEntryId}`)
        }
        for (const e of entries) {
          if (e.parseError) log('warn', `[mcp-manager] 条目 ${e.id} 解析告警：${e.parseError}`)
        }
        return { file, entries }
      } catch (e) {
        // 绝不留坏文件：校验没过就整份回滚到写入前的内容
        try {
          const rollbackTmp = `${file}.tmp-mcp-manager-rollback`
          fs.writeFileSync(rollbackTmp, previous, 'utf8')
          fs.renameSync(rollbackTmp, file)
          log('warn', `[mcp-manager] 写入校验失败，已回滚 ${file}：${messageOf(e)}`)
        } catch (rollbackError) {
          log('error', `[mcp-manager] 回滚失败，${file} 可能已损坏：${messageOf(rollbackError)}`)
        }
        throw new Error(`${messageOf(e)}（已回滚到写入前的内容）`)
      }
    }

    function withLock(fn) {
      const run = writeChain.then(fn, fn)
      writeChain = run.then(() => undefined, () => undefined)
      return run
    }

    async function liveServersNow() {
      const manager = ctx.get('pluginManager')
      if (!manager || typeof manager.listPlugins !== 'function') return null
      try {
        return pickLiveServers(await manager.listPlugins(), moduleName)
      } catch {
        return null
      }
    }

    /** 给可能长时间不返回的宿主调用加个上限（例如条目卡在 MCP 握手时 reload 会等很久）。 */
    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内返回`)), ms)
        Promise.resolve(promise).then(
          (value) => { clearTimeout(timer); resolve(value) },
          (error) => { clearTimeout(timer); reject(error) },
        )
      })
    }

    /**
     * 写盘后探测 DSH 是否真的把这次改动热加载进来了。
     *
     * 实测：DSH 会监视 cordis.patch.yml 并热应用，但**不是瞬间的** ——
     * 写入后大约 2–6 秒条目才进入运行树，所以给 3 秒窗口。更关键的是**不只看"在不在"**：
     *   · fiberPhase === 'active' 才算真正加载成功；
     *   · 'failed' 表示条目在树里但加载失败 —— 必须如实报出来，不能谎报"已生效"；
     *   · 编辑一个**本来就在运行**的条目时，旧实例一直都在，探测无法区分新旧配置，
     *     这种情况直接返回 'unknown'，由调用方保守表述。
     *
     * @returns {Promise<'active'|'failed'|'present'|'absent'|'unknown'>}
     */
    async function probeLiveAfterWrite(entryId, mode) {
      if (mode === 'edited') return 'unknown'
      const deadline = Date.now() + 3000
      let last = null
      for (;;) {
        const live = await liveServersNow()
        if (live === null) return 'unknown'
        const hit = matchLive(live, entryId)
        last = hit
        if (mode === 'removed') {
          if (hit === null) return 'absent'
        } else if (hit && hit.enabled !== false && hit.phase === 'active') {
          return 'active'
        }
        if (Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (mode === 'removed') return 'present'
      if (last && last.phase === 'failed') return 'failed'
      return last ? 'present' : 'absent'
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

      // 改动前该条目是否已经在运行：决定"热加载能否被确认"（在跑的旧实例会掩盖新配置）
      const beforeLive = await liveServersNow()
      const wasLive = originalId !== null && beforeLive !== null && matchLive(beforeLive, originalId) !== null

      // 改 id：先删旧条目再按新 id 写入，避免留下孤儿条目
      let working = text
      if (originalId && originalId !== id) {
        const removed = patchFile.removeEntry(working, originalId)
        if (!removed.removed) throw new Error(`找不到要修改的条目 ${originalId}`)
        working = removed.text
      }
      const upserted = patchFile.upsertEntry(working, { id, moduleName, config: serverConfig })
      const written = writePatchText(upserted.text, id)
      const liveState = await probeLiveAfterWrite(id, wasLive ? 'edited' : 'added')
      const NOTES = {
        active: '配置已写入 profile 文件，并且 DSH 已热加载该条目（已生效）。',
        failed: '配置已写入 profile 文件，但该条目在 DSH 里加载失败（fiber = failed）—— 请检查配置内容或 DSH 日志。',
        unknown: '配置已写入 profile 文件。该条目原本就在运行，热加载有没有把新配置换上去无法自动确认 —— 要确保生效请重启 DSH。',
        pending: '配置已写入 profile 文件。DSH 通常会在几秒内自动热加载 —— 设置页会显示最新状态；若一直显示「待重启生效」，重启 DSH 即可。',
      }
      return {
        ok: true,
        action: upserted.action,
        id,
        file: written.file,
        restartRequired: liveState !== 'active',
        live: liveState === 'active',
        liveState,
        note: NOTES[liveState] || NOTES.pending,
      }
    }

    async function removeServer(body) {
      const id = body && typeof body.id === 'string' ? body.id : ''
      if (id === '') throw new Error('缺少 id')
      const text = readPatchText()
      // 先看它删除前是不是真的在运行 —— 否则"已卸载"就是误报（条目可能本来就没加载过）
      const beforeLive = await liveServersNow()
      const wasLive = beforeLive !== null && matchLive(beforeLive, id) !== null
      const removed = patchFile.removeEntry(text, id)
      if (!removed.removed) {
        const err = new Error(`找不到条目 ${id}`)
        err.statusCode = 404
        throw err
      }
      const remaining = patchFile.listMcpEntries(removed.text, moduleName)
      const written = writePatchText(removed.text, remaining.length > 0 ? remaining[0].id : null)
      // 只有"删除前它真的在运行"才可能确认卸载；否则不能宣称"已卸载"
      const liveState = wasLive ? await probeLiveAfterWrite(id, 'removed') : 'unknown'
      const unloaded = liveState === 'absent'
      return {
        ok: true,
        id,
        file: written.file,
        restartRequired: wasLive && !unloaded,
        live: unloaded,
        liveState,
        note: unloaded
          ? '条目已从 profile 文件删除，并且已从运行中的 DSH 卸载。'
          : '条目已从 profile 文件删除；它的连接（如果已经建立）会保留到 DSH 重启。',
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

      // 1) 尽力走官方热停用。它的实现是「先写 profile patch，再 reload 运行树」，而 reload
      //    在条目卡住时（例如 MCP 握手一直没完成）会等很久，所以给一个上限。
      let change = null
      let hotError = null
      if (live && manager && typeof manager.setPluginEnabled === 'function') {
        try {
          change = await withTimeout(
            manager.setPluginEnabled(live.entryId, enabled),
            mutateTimeoutMs,
            'pluginManager.setPluginEnabled',
          )
        } catch (e) {
          hotError = messageOf(e)
          log('warn', `[mcp-manager] ${hotError}`)
        }
      }

      // 2) 不管上面结果如何，都保证 profile 文件里的启用状态是对的。
      //    官方 writePluginEnabled 只在「不含 insert 的顶层项」里按 id 匹配，对 `- insert:`
      //    内部的 MCP 条目匹配不到就新加顶层项，而且实测并不会在我们的等待窗口内落盘；
      //    这里用**完全相同的形式**（顶层 `- id: X` + `disabled: true`）把它补齐，
      //    界面显示与重启后的行为才一致。注意要用**重新读到的最新文本**，别用调用前的旧文本。
      const latestText = readPatchText()
      const current = patchFile.listMcpEntries(latestText, moduleName).find((e) => e.id === id)
      let persisted = false
      if (current && current.disabled !== !enabled) {
        const toggled = patchFile.setEntryDisabled(latestText, id, !enabled)
        if (toggled.changed) {
          writePatchText(toggled.text, id)
          persisted = true
        }
      }

      const hotApplied = !!change && change.application === 'applied'
      return {
        ok: true,
        id,
        enabled,
        applied: hotApplied ? 'applied' : (hotError ? 'pending' : 'persisted'),
        restartRequired: !hotApplied,
        liveState: hotApplied ? 'active' : 'unknown',
        note: hotApplied
          ? '已立即生效；启用状态同时写进了 profile patch（顶层 `- id:` 覆盖项），重启后依然保留。'
          : hotError
            ? `启用状态已写入 profile patch（重启后保留）。热停用没在 ${Math.round(mutateTimeoutMs / 1000)} 秒内完成（${hotError}）—— 多半是该服务器还在连接中，稍后刷新看状态。`
            : (persisted
                ? '启用状态已写入 profile patch（顶层 `- id:` 覆盖项），重启 DSH 后完全生效。'
                : '状态未发生变化。'),
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
            const status = payload && payload.statusCode ? payload.statusCode : 200
            sendJson(res, status, payload)
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
