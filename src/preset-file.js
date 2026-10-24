'use strict'

/**
 * preset-file —— 在 profile 的 `cordis.patch.yml` 里管理「会话模式」（agent preset）。
 *
 * 为什么走 profile patch 而不是运行时 `agentPresets.register()`：
 *   · 官方文档明确说新建 preset 的唯一正规途径是「插入一行
 *     `@deepseek-ai/dsh-agent-preset` 的 bundle 补丁」；运行时注册只活到进程结束，
 *     重启就消失，用户下次打开 DSH 会发现模式没了。
 *   · 走 profile patch 完全复用本插件已有的能力：行级编辑、保留注释、备份、
 *     原子写、写后结构自检与整份回滚。不需要引入 js-yaml，也不需要解析别人的 preset。
 *
 * 生成的行形如：
 *
 *   - id: mcp-manager-preset-comfy
 *     name: '@deepseek-ai/dsh-agent-preset'
 *     config:
 *       id: mcp-comfy
 *       name: 标准 + comfy
 *       description: 由 mcp-manager 生成：...
 *       order: 50
 *       plugins:
 *         - id: ...           # 基础模式的条目（原样复制）
 *         - id: mcp-comfy
 *           name: '@deepseek-ai/dsh-mcp-client'
 *           config: { ... }
 *
 * 要点：`plugins` 必须是完整条目列表 —— preset 是「完整组合」，不继承 Host 的工具。
 * 所以生成时必须把基础模式的条目整体复制过来，再追加 MCP 条目。
 */

const {
  indentOf,
  isComment,
  stripComment,
  dumpScalar,
  dumpYaml,
  parseYamlSubset,
} = require('./yaml-mini.js')
const patchFile = require('./patch-file.js')

const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

function isTopItem(line) {
  const raw = stripComment(line).trimEnd()
  return raw !== '' && indentOf(raw) === 0 && /^-\s/.test(raw)
}

/**
 * 找出文件里所有 `name: '@deepseek-ai/dsh-agent-preset'` 的条目。
 *
 * 直接复用 patch-file.scanPatch：它已经正确处理「`- insert:` 的键在第 2 列」
 * 「组定向插入要跳过」等历史坑，这里只按模块名筛出 preset 条目。
 * 注意每条组合是**独立 insert 块**（profile patch 顶层 `- id:` 是覆盖语义，
 * 新增必须走 insert），所以 start/end 落在块内子条目的行范围上。
 */
function scanPresetRows(text) {
  const scanned = patchFile.scanPatch(text)
  return {
    lineEnding: scanned.lineEnding,
    lines: scanned.lines,
    rows: scanned.entries
      .filter((e) => e.moduleName === PRESET_MODULE)
      .map((e) => ({
        start: e.start,
        end: e.end,
        id: e.id,
        itemIndent: e.itemIndent,
        config: e.config && typeof e.config === 'object' ? e.config : null,
        parseError: e.parseError,
      })),
  }
}

/** 读出现有的 mcp-manager 生成的模式（按 patch 行 id 前缀识别）。 */
function listPresetRows(text) {
  const scanned = scanPresetRows(text)
  return scanned.rows.map((row) => {
    const body = scanned.lines.slice(row.start, row.end)
    // 有 `!!js` 时 config 解析不全，用正则兜底读 preset id / name / description。
    // 层级（itemIndent 默认 4）：config 字段 8 列，plugins 元素 6 列。
    const cfgText = body.join('\n')
    const pick = (key) => {
      const m = new RegExp(`^\\s{8}${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm').exec(cfgText)
      return m ? m[1].trim() : null
    }
    const pluginsIdx = body.findIndex((l) => /^\s{8}plugins:\s*$/.test(l))
    let pluginCount = 0
    if (pluginsIdx >= 0) {
      for (let i = pluginsIdx + 1; i < body.length; i++) {
        if (body[i].trim() === '') continue
        if (/^\s{10}-\s+id:/.test(body[i])) { pluginCount++; continue }
        // 元素内部更深，继续；回到 10 列但不是 `- id:` 或更浅 → 数组结束
        if (/^\s{10}\S/.test(body[i])) break
      }
    }
    return {
      rowId: row.id,
      presetId: row.config && typeof row.config.id === 'string' ? row.config.id : pick('id'),
      name: row.config && typeof row.config.name === 'string' ? row.config.name : pick('name'),
      description: row.config && typeof row.config.description === 'string' ? row.config.description : pick('description'),
      plugins: row.config && Array.isArray(row.config.plugins) ? row.config.plugins : [],
      pluginCount,
      parseError: row.parseError,
    }
  })
}

/**
 * 生成一条 preset 条目的 YAML 行。
 *
 * **必须包在 `- insert:` 块里**：profile patch 顶层的 `- id:` 是「覆盖已有 entry」语义，
 * 直接写顶层会被 DSH 报 `patch: entry "..." not found`。新增插件只能走 insert。
 * 所以这里每条组合生成一个独立 insert 块，删改都只动自己这一块。
 *
 * `pluginLines` 是**已经缩进好的原始文本行**（来自 bundle 的 standard.patch.yml），
 * 刻意不经过 dumpYaml —— 那会丢掉 `!!js` 表达式与 group/isolate 结构。
 * 块内层级：`- id:` 在 4 列，`config:` 在 6 列，`plugins:` 在 8 列，元素在 10 列。
 */
function genPresetLines(spec) {
  const out = ['- insert:', `    - id: ${dumpScalar(spec.rowId)}`, `      name: ${dumpScalar(PRESET_MODULE)}`, '      config:']
  out.push(`        id: ${dumpScalar(spec.presetId)}`)
  if (spec.name !== undefined && spec.name !== null) out.push(`        name: ${dumpScalar(spec.name)}`)
  if (spec.description !== undefined && spec.description !== null) out.push(`        description: ${dumpScalar(spec.description)}`)
  if (spec.order !== undefined && spec.order !== null) out.push(`        order: ${dumpScalar(spec.order)}`)

  const items = Array.isArray(spec.pluginLines) ? spec.pluginLines : []
  if (items.length === 0) {
    out.push('        plugins: []')
    return out
  }
  out.push('        plugins:')
  for (const line of reindentBlock(items, spec.sourceItemIndent, 10)) out.push(line)
  return out
}

/**
 * 把一段插件行块从 `fromIndent` 重排到 `toIndent`（只改前导空格，内容逐字节保留）。
 * 空行原样输出（不带空格）。
 */
function reindentBlock(lines, fromIndent, toIndent) {
  const delta = toIndent - fromIndent
  return lines.map((line) => {
    if (line.trim() === '') return ''
    const ind = indentOf(line)
    const next = Math.max(0, ind + delta)
    return ' '.repeat(next) + line.slice(ind)
  })
}

/** 顶层 `[]` 行号（新建 profile 的 patch 文件内容）。 */
function findEmptyFlowArrayLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '') continue
    if (indentOf(raw) !== 0) continue
    if (/^\[\s*\]$/.test(raw.trim())) return i
  }
  return -1
}

/**
 * 新增或整体替换一条 preset 声明（按 patch 行 id 匹配）。
 *
 * 三种 action：
 *   · updated —— 已有同 id 条目，原地替换它的行（保留所在 insert 块与其它条目）
 *   · created —— 文件是 `[]`（新 profile），展开成第一个 insert 块
 *   · appended —— 追加一个新的 `- insert:` 块
 *
 * @returns {{ text: string, action: 'updated'|'appended'|'created' }}
 */
function upsertPresetRow(text, spec) {
  const scanned = scanPresetRows(text)
  const existing = scanned.rows.find((row) => row.id === spec.rowId)
  const lines = scanned.lines.slice()

  // 统一处理尾部空行：先摘掉、写完再按原样补回。
  // 这样三个分支对「文件结尾多一个换行」的处理一致，重复保存不会每次都多出空行。
  const trailing = []
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') trailing.push(lines.pop())

  let action
  if (existing) {
    // 只替换条目自身的行；条目开头的 `- id:` 与 insert 块头都保持原样。
    const body = genEntryLines(spec, existing.itemIndent)
    const end = Math.min(existing.end, lines.length)
    lines.splice(existing.start, end - existing.start, ...body)
    action = 'updated'
  } else {
    const block = genInsertBlock(spec)
    const emptyArrayLine = findEmptyFlowArrayLine(lines)
    if (emptyArrayLine >= 0) {
      lines.splice(emptyArrayLine, 1, ...block)
      action = 'created'
    } else {
      lines.push('', ...block)
      action = 'appended'
    }
  }

  for (let i = 0; i < trailing.length; i++) lines.push(trailing[i])
  return { text: lines.join(scanned.lineEnding), action }
}

/** 生成一个独立的 `- insert:` 块（含一条 preset 声明）。 */
function genInsertBlock(spec) {
  return ['- insert:', ...genEntryLines(spec, 4)]
}

/**
 * 生成 preset 声明的条目行。
 * @param {number} itemIndent 条目 `- id:` 中 `-` 所在列（insert 块内默认 4）
 */
function genEntryLines(spec, itemIndent) {
  const pad = ' '.repeat(itemIndent)
  const k1 = ' '.repeat(itemIndent + 2) // name / config（条目内一级）
  const k2 = ' '.repeat(itemIndent + 4) // config 下的字段，含 plugins
  const k3 = itemIndent + 6 // plugins 数组元素 `- id:`

  const out = [`${pad}- id: ${dumpScalar(spec.rowId)}`, `${k1}name: ${dumpScalar(PRESET_MODULE)}`, `${k1}config:`]
  out.push(`${k2}id: ${dumpScalar(spec.presetId)}`)
  if (spec.name !== undefined && spec.name !== null) out.push(`${k2}name: ${dumpScalar(spec.name)}`)
  if (spec.description !== undefined && spec.description !== null) out.push(`${k2}description: ${dumpScalar(spec.description)}`)
  if (spec.order !== undefined && spec.order !== null) out.push(`${k2}order: ${dumpScalar(spec.order)}`)

  const items = Array.isArray(spec.pluginLines) ? spec.pluginLines : []
  if (items.length === 0) {
    out.push(`${k2}plugins: []`)
    return out
  }
  out.push(`${k2}plugins:`)
  for (const line of reindentBlock(items, spec.sourceItemIndent, k3)) out.push(line)
  return out
}

/**
 * 删除一条 preset 声明。
 * 复用 patch-file.removeEntry：它会同时处理「块因此变空就连 `- insert:` 一起删」。
 * @returns {{ text: string, removed: boolean }}
 */
function removePresetRow(text, rowId) {
  const scanned = scanPresetRows(text)
  const existing = scanned.rows.find((row) => row.id === rowId)
  if (!existing) return { text, removed: false }
  const result = patchFile.removeEntry(text, rowId)
  if (!result.removed) return { text, removed: false }
  // 文件里只剩空行/注释时，还原成新建 profile 的 `[]`
  const lines = String(result.text).replace(/\r\n?/g, '\n').split('\n')
  const meaningful = lines.filter((l) => !isComment(l) && l.trim() !== '')
  if (meaningful.length === 0) {
    const trailing = []
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') trailing.push(lines.pop())
    lines.push('[]')
    for (let i = 0; i < trailing.length; i++) lines.push(trailing[i])
    return { text: lines.join('\n'), removed: true }
  }
  return { text: result.text, removed: true }
}

/**
 * 写盘后的结构自检：确认目标 preset 行存在、能解析、且 `plugins` 是数组。
 * 对应 patch-file.assertSafePatch 的同类保护 —— 不通过就整份回滚。
 */
function assertSafePresetPatch(text, rowId) {
  const scanned = scanPresetRows(text)
  const row = scanned.rows.find((r) => r.id === rowId)
  if (!row) throw new Error(`回读校验失败：找不到写入的模式条目 ${rowId}`)
  // 有 `!!js` 表达式时 yaml-mini 解析必然失败 —— 这不是错误，改用结构断言：
  // 条目必须真的包含 plugins: 且其下至少有一个 `- id:` 元素行。
  const body = scanned.lines.slice(row.start, row.end).join('\n')
  if (!/^\s+plugins:\s*$/m.test(body)) throw new Error(`回读校验失败：模式条目 ${rowId} 没有 plugins:`)
  const pluginsIdx = body.split('\n').findIndex((l) => /^\s+plugins:\s*$/.test(l))
  const after = body.split('\n').slice(pluginsIdx + 1)
  if (!after.some((l) => /^\s*-\s+id:/.test(l))) {
    throw new Error(`回读校验失败：模式条目 ${rowId} 的 plugins 为空（preset 必须是完整组合）`)
  }
  if (row.parseError && row.config && Array.isArray(row.config.plugins) && row.config.plugins.length === 0) {
    throw new Error(`回读校验失败：模式条目 ${rowId} 的 plugins 为空`)
  }
}

/**
 * 把一个 MCP 服务器配置转成 preset `plugins` 里的条目文本行（相对缩进，起始 0 列）。
 * 由 genEntryLines 统一 reindent 到目标层级 —— 调用方不要再自己加缩进，
 * 否则会和基础块的重排逻辑错位（历史 bug：MCP 行缩进多了 4 列，DSH 解析直接失败）。
 */
function mcpPluginLines(server) {
  const out = [`- id: ${dumpScalar(server.id)}`, `  name: ${dumpScalar(MCP_MODULE)}`]
  const config = server.config || {}
  const keys = Object.keys(config)
  if (keys.length === 0) {
    out.push('  config: {}')
  } else {
    out.push('  config:')
    for (const line of dumpYaml(config, 4)) out.push(line)
  }
  return out
}

/**
 * 生成 preset 的 `plugins` 数组行：基础块重排到目标层级，MCP 行同样重排。
 * @param {string[]} baseLines 基础块原始行（10 列起始）
 * @param {number} baseIndent 基础块的元素缩进
 * @param {{id:string, config:object}[]} servers 要追加的 MCP 服务器
 * @param {number} targetIndent 目标元素缩进
 */
function composePluginsLines(baseLines, baseIndent, servers, targetIndent) {
  const out = reindentBlock(baseLines, baseIndent, targetIndent)
  for (const server of servers) {
    out.push(...reindentBlock(mcpPluginLines(server), 0, targetIndent))
  }
  return out
}

module.exports = {
  PRESET_MODULE,
  MCP_MODULE,
  scanPresetRows,
  listPresetRows,
  genPresetLines,
  mcpPluginLines,
  composePluginsLines,
  reindentBlock,
  upsertPresetRow,
  removePresetRow,
  assertSafePresetPatch,
}
