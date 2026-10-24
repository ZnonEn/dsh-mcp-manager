'use strict'

/**
 * preset-spec —— 构造「会话模式」的 plugins 数组文本。
 *
 * 为什么用**文本复制**而不是解析再生成：
 *   · preset 的 plugins 里允许 `!!js` 表达式（如 `disabled: !!js process.platform === 'win32'`）
 *     与 `cordis:group` + `group/isolate` 嵌套结构。用 yaml-mini 解析再 dump 需要
 *     完整支持这些语义，等于重写一个 YAML 库（插件刻意零依赖）。
 *   · 官方 bundle 里的 standard.patch.yml 是稳定来源，直接按缩进切片复制，
 *     `!!js` 与嵌套结构原样保留，语义零损耗。
 *
 * 数据来源优先级：
 *   1) profile patch 里已有的同 id preset（用户/插件之前生成的）—— 说明用户改过，尊重它；
 *   2) bundle 的 base preset 文件（standard/minimal/ptc）—— 全新生成时用。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 内置 preset 的档位（对应 dsh-web-app/presets/<base>.patch.yml）。 */
const BASE_PRESETS = ['standard', 'ptc', 'minimal']

/**
 * 从一段 entry-list 文本里切出「某个 preset 条目的 plugins 数组」的行块。
 * 返回的是相对 `plugins:` 行**下一行**起的原始行（保留各自缩进）。
 *
 * @param {string} text - 含 `id: <presetRowId>` 行的 YAML 文本
 * @param {string} presetRowId - 例如 'preset-standard'
 * @returns {{ pluginsIndent: number, lines: string[] } | null}
 */
function extractPluginsBlock(text, presetRowId) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const idRe = new RegExp(`^\\s*-\\s+id:\\s*['"]?${presetRowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (idRe.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null

  // 该条目结束位置：下一个缩进 ≤ 起始项缩进的非空非注释行
  const startIndent = lines[start].search(/\S/)
  const itemIndent = startIndent // `- id:` 的 `-` 所在列
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, '')
    if (raw === '' || /^\s*#/.test(raw)) continue
    const ind = raw.search(/\S/)
    if (ind <= itemIndent) { end = i; break }
  }

  // 在条目里找到 `plugins:` 这一行
  let pluginsLine = -1
  let pluginsIndent = -1
  for (let i = start + 1; i < end; i++) {
    const m = /^(\s*)plugins:\s*(\[\s*\])?\s*$/.exec(lines[i])
    if (m) { pluginsLine = i; pluginsIndent = m[1].length; break }
  }
  if (pluginsLine < 0) return null

  // 数组元素：比 pluginsIndent 深、且以 `- ` 开头的行；块到下一个不更深的行为止
  const firstItemIndent = findFirstListItemIndent(lines, pluginsLine + 1, end, pluginsIndent)
  if (firstItemIndent < 0) return { pluginsIndent, lines: [], itemIndent: pluginsIndent + 2 }

  let blockEnd = end
  for (let i = pluginsLine + 1; i < end; i++) {
    const raw = lines[i].replace(/\s+$/, '')
    if (raw === '' || /^\s*#/.test(raw)) continue
    const ind = raw.search(/\S/)
    if (ind < firstItemIndent) { blockEnd = i; break }
  }

  const block = []
  for (let i = pluginsLine + 1; i < blockEnd; i++) block.push(lines[i])
  // 去掉尾部空行（保留内容语义，避免把空行带进新条目）
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()

  return { pluginsIndent, itemIndent: firstItemIndent, lines: block }
}

function findFirstListItemIndent(lines, from, to, pluginsIndent) {
  for (let i = from; i < to; i++) {
    const raw = lines[i].replace(/\s+$/, '')
    if (raw === '' || /^\s*#/.test(raw)) continue
    const ind = raw.search(/\S/)
    if (ind <= pluginsIndent) return -1
    if (/^\s*-(\s|$)/.test(raw)) return ind
    return -1
  }
  return -1
}

/**
 * 找出 bundle 里内置 preset 的定义文件。
 *
 * 桌面端与 CLI 的安装位置不同，而且桌面端在 `app.asar` 里 —— `fs` 能读 asar 内的
 * 路径（Electron 打了补丁），但路径推导必须靠真实线索而不是猜 `process.execPath`：
 *   1) 插件自己被装在哪：`<profile>/node_modules/dsh-mcp-manager` → 上溯找 dsh 包；
 *   2) `DSH_BUNDLE_ROOT` 显式覆盖（排错用）；
 *   3) 常见全局安装位置（npm 全局、桌面端 resources）；
 *   4) `process.argv` 里出现的 dsh 目录。
 */
function findBundlePresetFiles() {
  const roots = new Set()

  if (process.env.DSH_BUNDLE_ROOT) roots.add(process.env.DSH_BUNDLE_ROOT)

  // 1) 从本文件位置上溯：<...>/dsh-mcp-manager/src/preset-spec.js
  //    目标是找到包含 node_modules/@deepseek-ai/dsh-web-app 的目录。
  try {
    let dir = __dirname
    for (let i = 0; i < 8; i++) {
      dir = path.dirname(dir)
      if (!dir || dir === path.dirname(dir)) break
      roots.add(dir)
      // profile 级：<profile>/node_modules/<pkg>/... → 上溯到 profile 的 node_modules 父级
      const nm = path.join(dir, 'node_modules', '@deepseek-ai')
      if (isDir(nm)) roots.add(dir)
    }
  } catch { /* ignore */ }

  // 2) npm 全局安装位置
  const appData = process.env.APPDATA
  if (appData) roots.add(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  if (process.env.LOCALAPPDATA) {
    roots.add(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    roots.add(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'))
  }

  // 3) argv 里出现的 dsh 路径
  for (const arg of process.argv) {
    if (typeof arg !== 'string' || !path.isAbsolute(arg)) continue
    if (!/deepseek harness|@deepseek-ai[\\/]dsh/i.test(arg)) continue
    let dir = arg
    for (let i = 0; i < 6; i++) {
      dir = path.dirname(dir)
      if (!dir || dir === path.dirname(dir)) break
      roots.add(dir)
    }
  }

  const files = []
  const seen = new Set()
  for (const root of roots) {
    for (const base of BASE_PRESETS) {
      const candidates = [
        path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', `${base}.patch.yml`),
        path.join(root, '@deepseek-ai', 'dsh-web-app', 'presets', `${base}.patch.yml`),
        path.join(root, 'presets', `${base}.patch.yml`),
      ]
      for (const p of candidates) {
        if (seen.has(p) || !isFile(p)) continue
        seen.add(p)
        files.push({ base, file: p })
      }
    }
  }
  return files
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/**
 * 把一段插件行块从 `fromIndent` 重排到 `toIndent`（只改前导空格，内容逐字节保留）。
 * 空行输出为空串，避免把多余空白带进配置文件。
 */
function reindentLines(lines, fromIndent, toIndent) {
  const delta = toIndent - fromIndent
  return lines.map((line) => {
    if (line.trim() === '') return ''
    const ind = line.search(/\S/)
    const next = Math.max(0, ind + delta)
    return ' '.repeat(next) + line.slice(ind)
  })
}

module.exports = {
  BASE_PRESETS,
  extractPluginsBlock,
  findBundlePresetFiles,
  reindentLines,
}
