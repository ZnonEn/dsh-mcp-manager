'use strict'

/**
 * locate —— 找出当前正在运行的 DSH 用的是哪个 profile 目录。
 *
 * 为什么不能靠 `--profile <name>`：
 *   DSH 桌面版由 `dsh-desktop-host` 启动 harness，命令行里**没有** `--profile`，
 *   而是把 profile 目录作为位置参数传进来（实测：
 *   `... dsh-desktop-host/lib/index.js <checkout> C:\Users\<u>\.dsh\profiles\desktop <runtime...>`）。
 *   之前有插件只看 `--profile`，于是回落到 'web'，读到了另一个 profile 的配置，
 *   设置页显示的数据与实际不符 —— 这里按「argv 里的真实目录」优先定位，
 *   并用 live 的 patch id 做指纹兜底交叉验证。
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { indentOf, stripComment, isComment } = require('./yaml-mini.js')

const PATCH_FILE = 'cordis.patch.yml'
const PROFILE_MARKERS = [PATCH_FILE, 'cordis.yml']

function defaultFs() {
  return {
    isDir(p) {
      try { return fs.statSync(p).isDirectory() } catch { return false }
    },
    exists(p) {
      try { fs.accessSync(p); return true } catch { return false }
    },
    readText(p) {
      return fs.readFileSync(p, 'utf8')
    },
    listDirs(p) {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch { return [] }
    },
  }
}

function dshHome(env) {
  return env.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? String(env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}

function isProfileDir(dir, io) {
  if (!io.isDir(dir)) return false
  return PROFILE_MARKERS.some((m) => io.exists(path.join(dir, m)))
}

/** 取 patch 文件里顶层条目的 `- id:` 值集合（指纹用）。 */
function topLevelPatchIds(text) {
  const ids = new Set()
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '') continue
    const lead = indentOf(raw)
    const body = raw.slice(lead)
    // 顶层 `- id: xxx`（lead 0）或 `- insert:` 内的 `- id:`（lead > 0）
    if (!body.startsWith('- ')) continue
    const rest = body.slice(2).trim()
    const m = /^id\s*:\s*(.+)$/.exec(rest)
    if (!m) continue
    let v = m[1].trim()
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    if (v !== '') ids.add(v)
  }
  return ids
}

/**
 * @param {object} [options]
 * @param {string[]} [options.argv]          默认 process.argv
 * @param {Record<string,string>} [options.env] 默认 process.env
 * @param {object} [options.io]              注入文件系统能力（测试用）
 * @param {string[]} [options.livePatchIds]  live Loader 里已知的 patch id（指纹兜底）
 * @returns {{ dir: string|null, source: string, candidates: Array<{dir:string, reason:string, score?:number}>, warnings: string[] }}
 */
function locateProfileDir(options = {}) {
  const argv = options.argv || process.argv || []
  const env = options.env || process.env || {}
  const io = options.io || defaultFs()
  const livePatchIds = Array.isArray(options.livePatchIds) ? options.livePatchIds : []
  const candidates = []
  const warnings = []
  const home = dshHome(env)

  // 1) 显式覆盖（排查问题时最有用）
  const explicit = String(env.DSH_MCP_MANAGER_PROFILE || '').trim()
  if (explicit !== '') {
    if (isProfileDir(explicit, io)) return { dir: explicit, source: 'env:DSH_MCP_MANAGER_PROFILE', candidates, warnings }
    warnings.push(`环境变量 DSH_MCP_MANAGER_PROFILE 指向的目录不是 profile（缺 ${PATCH_FILE}/cordis.yml）：${explicit}`)
  }

  // 2) 命令行里的真实 profile 目录（桌面版就是靠位置参数传的）
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg === '') continue
    if (arg.startsWith('-')) continue
    if (!path.isAbsolute(arg)) continue
    if (!io.isDir(arg)) continue
    const hasPatch = io.exists(path.join(arg, PATCH_FILE))
    if (!hasPatch && !isProfileDir(arg, io)) continue
    candidates.push({ dir: arg, reason: hasPatch ? 'argv（含 cordis.patch.yml）' : 'argv（含 cordis.yml）' })
  }
  const argvHit = candidates.find((c) => c.reason.includes(PATCH_FILE))
  if (argvHit) return { dir: argvHit.dir, source: 'argv', candidates, warnings }

  // 3) 环境变量显式指定
  const envDir = String(env.DSH_PROFILE_DIR || '').trim()
  if (envDir !== '' && isProfileDir(envDir, io)) {
    return { dir: envDir, source: 'env:DSH_PROFILE_DIR', candidates, warnings }
  }

  // 4) 指纹兜底：扫 <DSH_HOME>/profiles/*，与 live patch id 求交集
  const profilesRoot = path.join(home, 'profiles')
  const scanned = []
  for (const name of io.listDirs(profilesRoot)) {
    const dir = path.join(profilesRoot, name)
    const patchPath = path.join(dir, PATCH_FILE)
    if (!io.exists(patchPath)) continue
    let score = 0
    try {
      const ids = topLevelPatchIds(io.readText(patchPath))
      for (const id of livePatchIds) if (ids.has(id)) score++
    } catch { /* 读不了就跳过 */ }
    scanned.push({ dir, score })
  }
  scanned.sort((a, b) => b.score - a.score)
  if (scanned.length > 0 && scanned[0].score > 0) {
    candidates.push({ dir: scanned[0].dir, reason: `按 live patch id 指纹匹配（命中 ${scanned[0].score} 项）`, score: scanned[0].score })
    return { dir: scanned[0].dir, source: 'fingerprint', candidates, warnings }
  }
  for (const s of scanned) candidates.push({ dir: s.dir, reason: '同 DSH_HOME 下的 profile（未命中指纹）', score: s.score })
  if (scanned.length > 1) {
    warnings.push('未能通过 argv 或指纹确定 profile，已回退到 DSH_HOME 下的默认 profile')
  }

  // 5) 最后回退
  const fallback = ['desktop', 'web'].map((n) => path.join(profilesRoot, n)).find((d) => isProfileDir(d, io))
  if (fallback) return { dir: fallback, source: 'fallback', candidates, warnings }
  if (scanned.length > 0) return { dir: scanned[0].dir, source: 'scan', candidates, warnings }

  return { dir: null, source: 'none', candidates, warnings }
}

module.exports = {
  PATCH_FILE,
  PROFILE_MARKERS,
  locateProfileDir,
  topLevelPatchIds,
  isProfileDir,
  dshHome,
}
