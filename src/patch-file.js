'use strict'

/**
 * patch-file —— 读写 DSH profile 的 `cordis.patch.yml`，只做行级增删改。
 *
 * 关键取舍：**不做整文件重排**。所有写操作都只替换/插入/删除"本次要动的那个
 * 条目"的行范围，其余内容（包括用户自己写的注释、`!!js` 表达式、其它插件的
 * 配置）逐字节保持原样。这样即使用户的 patch 文件里有本实现看不懂的结构，
 * 也不会被写坏。
 */

const { indentOf, isComment, stripComment, parseYamlSubset, dumpScalar, dumpYaml } = require('./yaml-mini.js')

/** 默认的 MCP 客户端插件包名（可在插件 config 里覆盖，见 index.js 的 moduleName）。 */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** 顶层序列项判定：`- x` / `-`（列 0）。 */
function isTopItem(line) {
  const raw = stripComment(line).trimEnd()
  if (raw === '') return false
  if (indentOf(raw) !== 0) return false
  return raw === '-' || raw.startsWith('- ')
}

/** 把文本切成顶层块（每个 `- xxx` 顶层项一块）。 */
function scanTopLevelBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (!isTopItem(lines[i])) continue
    let j = i + 1
    for (; j < lines.length; j++) {
      const raw = stripComment(lines[j]).trimEnd()
      if (raw === '') continue
      if (isComment(lines[j])) continue
      if (isTopItem(lines[j])) break
      if (indentOf(raw) === 0) break // 顶层出现非序列内容：保守地在此收束当前块
    }
    blocks.push({ start: i, end: j })
    i = j - 1
  }
  return blocks
}

/** 在 [from, to) 内找第一个内容行的缩进，用于探测子序列缩进。 */
function detectChildIndent(lines, from, to) {
  for (let i = from; i < to; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '' || isComment(lines[i])) continue
    return indentOf(raw)
  }
  return -1
}

/**
 * 扫描 patch 文本，取出所有 `- insert:` 块及其条目（不区分模块名）。
 * @returns {{
 *   lineEnding: string, lines: string[],
 *   inserts: Array<{blockStart:number, blockEnd:number, itemIndent:number, insertEnd:number}>,
 *   entries: Array<object>
 * }}
 */
function scanPatch(text) {
  const original = String(text)
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.replace(/\r\n?/g, '\n').split('\n')
  const blocks = scanTopLevelBlocks(lines)
  const inserts = []
  const entries = []

  for (const block of blocks) {
    // 顶层块里是否有 `insert:` 键。注意 `- insert:` 的键在第 2 列（`- ` 占两列），
    // 而不是块内普通行的第 2 列 —— 两者都要覆盖。
    let hasInsert = false
    for (let i = block.start; i < block.end; i++) {
      const raw = stripComment(lines[i]).trimEnd()
      if (raw === '' || isComment(lines[i])) continue
      const lead = indentOf(raw)
      const body = raw.slice(lead)
      const dash = body === '-' || body.startsWith('- ')
      const keyCol = dash ? lead + body.indexOf('-') + 2 : lead
      const keyText = dash ? body.slice(body.indexOf('-') + 1).trim() : body
      if (keyCol === 2 && /^insert\s*:/.test(keyText)) { hasInsert = true; break }
    }
    if (!hasInsert) continue

    const itemIndent = detectChildIndent(lines, block.start + 1, block.end)
    if (itemIndent < 0) {
      inserts.push({ blockStart: block.start, blockEnd: block.end, itemIndent: 4, insertEnd: block.end })
      continue
    }

    let insertEnd = itemIndent >= 0 ? block.start + 1 : block.end
    for (let i = block.start + 1; i < block.end; i++) {
      const raw = stripComment(lines[i]).trimEnd()
      if (raw === '' || isComment(lines[i])) continue
      if (indentOf(raw) !== itemIndent) continue
      const body = raw.slice(itemIndent)
      if (body !== '-' && !body.startsWith('- ')) continue

      // 条目结束行：下一个缩进 <= itemIndent 的内容行
      let j = i + 1
      for (; j < block.end; j++) {
        const r2 = stripComment(lines[j]).trimEnd()
        if (r2 === '' || isComment(lines[j])) continue
        if (indentOf(r2) <= itemIndent) break
      }
      const keyIndent = itemIndent + Math.max(2, body.indexOf('-') + 2)
      const entry = readEntry(lines, { start: i, end: j }, itemIndent, keyIndent)
      entries.push(entry)
      insertEnd = j
      i = j - 1
    }
    inserts.push({ blockStart: block.start, blockEnd: block.end, itemIndent, insertEnd })
  }

  return { lineEnding, lines, inserts, entries }
}

/** 读出一个 insert 条目的头部键与 config。解析失败时 parseError 有值，但行范围仍然有效。 */
function readEntry(lines, item, itemIndent, keyIndent) {
  const entry = {
    start: item.start,
    end: item.end,
    itemIndent,
    keyIndent,
    id: null,
    moduleName: null,
    disabled: false,
    config: null,
    parseError: null,
  }
  try {
    const slice = lines.slice(item.start, item.end)
    const body = stripComment(slice[0]).trimEnd().slice(itemIndent)
    const rest = body.slice(1).trim()
    slice[0] = ' '.repeat(keyIndent) + rest
    const parsed = parseYamlSubset(slice.join('\n'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      entry.id = typeof parsed.id === 'string' ? parsed.id : parsed.id === null || parsed.id === undefined ? null : String(parsed.id)
      entry.moduleName = typeof parsed.name === 'string' ? parsed.name : null
      entry.disabled = parsed.disabled === true
      entry.config = parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config) ? parsed.config : null
      entry.raw = parsed
    } else {
      entry.parseError = '条目不是一个映射'
    }
  } catch (e) {
    entry.parseError = String((e && e.message) || e)
  }
  return entry
}

/** 生成一个 insert 条目的 YAML 行（缩进由 itemIndent 决定）。 */
function genEntryLines(entry, itemIndent) {
  const keyIndent = itemIndent + 2
  const pad = ' '.repeat(itemIndent)
  const padKey = ' '.repeat(keyIndent)
  const out = [`${pad}- id: ${dumpScalar(entry.id)}`, `${padKey}name: ${dumpScalar(entry.moduleName)}`]
  const config = entry.config || {}
  const keys = Object.keys(config)
  if (keys.length === 0) {
    out.push(`${padKey}config: {}`)
  } else {
    out.push(`${padKey}config:`)
    for (const line of dumpYaml(config, keyIndent + 2)) out.push(line)
  }
  return out
}

/** 顶层 `[]`（空 flow 数组）的行号 —— 新建 profile 的 cordis.patch.yml 默认就是这一行。 */
function findEmptyFlowArrayLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '') continue
    if (indentOf(raw) !== 0) continue
    if (/^\[\s*\]$/.test(raw.trim())) return i
  }
  return -1
}

/** 文件里是否还有顶层条目（`- xxx` 开头的行）。 */
function hasTopLevelItem(lines) {
  return lines.some((line) => isTopItem(line))
}

/**
 * 新增或整体替换一个 insert 条目（按 id 匹配）。
 * @returns {{ text: string, action: 'updated'|'appended'|'created-insert' }}
 */
function upsertEntry(text, entry) {
  const scanned = scanPatch(text)
  const lines = scanned.lines.slice()
  const existing = scanned.entries.find((e) => e.id === entry.id)
  if (existing) {
    const gen = genEntryLines(entry, existing.itemIndent)
    lines.splice(existing.start, existing.end - existing.start, ...gen)
    return { text: lines.join(scanned.lineEnding), action: 'updated' }
  }
  const target = scanned.inserts[scanned.inserts.length - 1]
  if (target) {
    const gen = genEntryLines(entry, target.itemIndent)
    lines.splice(target.insertEnd, 0, ...gen)
    return { text: lines.join(scanned.lineEnding), action: 'appended' }
  }
  // 文件里还没有任何 insert 块。
  // 注意：新建 profile 的 patch 文件内容是 `[]`（flow 空数组），
  // 直接往后追加 `- insert:` 会变成「一个文档里既有 flow 序列又有 block 序列」的非法 YAML，
  // 所以这一行必须原地展开，而不是追加。
  const gen = genEntryLines(entry, 4)
  const emptyArrayLine = findEmptyFlowArrayLine(lines)
  if (emptyArrayLine >= 0) {
    lines.splice(emptyArrayLine, 1, '- insert:', ...gen)
    return { text: lines.join(scanned.lineEnding), action: 'created-insert' }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  lines.push('', '- insert:', ...gen, '')
  return { text: lines.join(scanned.lineEnding), action: 'created-insert' }
}

/**
 * 删除一个 insert 条目；若该条目所在的 `- insert:` 块因此变空，连块一起删除。
 * @returns {{ text: string, removed: boolean }}
 */
function removeEntry(text, id) {
  const scanned = scanPatch(text)
  const existing = scanned.entries.find((e) => e.id === id)
  if (!existing) return { text: String(text), removed: false }
  const lines = scanned.lines.slice()
  lines.splice(existing.start, existing.end - existing.start)

  const block = scanned.inserts.find((b) => existing.start >= b.blockStart && existing.start < b.blockEnd)
  if (block) {
    const stillHasItem = scanned.entries.some(
      (e) => e.id !== existing.id && e.start >= block.blockStart && e.start < block.blockEnd,
    )
    if (!stillHasItem) {
      // 块内已无条目：删除整个顶层块，避免留下空的 `- insert:`
      let end = block.blockEnd
      lines.splice(block.blockStart, end - block.blockStart)
    }
  }
  if (!hasTopLevelItem(lines) && findEmptyFlowArrayLine(lines) < 0) {
    // 文件里已经没有任何条目了：补一个合法的空数组字面量，
    // 让 patch 文件始终是「顶层数组」而不是空文档。
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('[]', '')
  }
  return { text: lines.join(scanned.lineEnding), removed: true }
}

/**
 * 写 `disabled: true` / 清除该键（同步生效需重启；热禁用请走 pluginManager）。
 * @returns {{ text: string, changed: boolean }}
 */
function setEntryDisabled(text, id, disabled) {
  const scanned = scanPatch(text)
  const existing = scanned.entries.find((e) => e.id === id)
  if (!existing) return { text: String(text), changed: false }
  const lines = scanned.lines.slice()
  const keyRe = /^disabled\s*:/
  let keyLine = -1
  for (let i = existing.start + 1; i < existing.end; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '' || isComment(lines[i])) continue
    if (indentOf(raw) !== existing.keyIndent) continue
    if (keyRe.test(raw.slice(existing.keyIndent))) { keyLine = i; break }
  }
  if (disabled) {
    const line = `${' '.repeat(existing.keyIndent)}disabled: true`
    if (keyLine >= 0) {
      if (lines[keyLine].trim() === 'disabled: true') return { text: String(text), changed: false }
      lines[keyLine] = line
    } else {
      lines.splice(existing.start + 1, 0, line)
    }
    return { text: lines.join(scanned.lineEnding), changed: true }
  }
  if (keyLine < 0) return { text: String(text), changed: false }
  lines.splice(keyLine, 1)
  return { text: lines.join(scanned.lineEnding), changed: true }
}

/** 取出当前文件里所有 MCP 服务器条目（按模块名过滤）。 */
function listMcpEntries(text, moduleName = MCP_CLIENT_MODULE) {
  const scanned = scanPatch(text)
  return scanned.entries
    .filter((e) => e.moduleName === moduleName)
    .map((e) => ({
      id: e.id,
      moduleName: e.moduleName,
      disabled: e.disabled,
      config: e.config,
      parseError: e.parseError,
    }))
}

/** 收集文件里所有已占用的条目 id：insert 条目 + 顶层 `- id:` 条目。 */
function collectEntryIds(text) {
  const scanned = scanPatch(text)
  const ids = new Set()
  for (const entry of scanned.entries) {
    if (typeof entry.id === 'string' && entry.id !== '') ids.add(entry.id)
  }
  for (const line of scanned.lines) {
    const raw = stripComment(line).trimEnd()
    if (raw === '') continue
    if (indentOf(raw) !== 0) continue
    const m = /^-\s+id\s*:\s*(.+)$/.exec(raw)
    if (!m) continue
    let value = m[1].trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    if (value !== '') ids.add(value)
  }
  return ids
}

/** 判断某 id 是否已被文件中任意条目占用（含顶层条目，避免 id 冲突）。 */
function hasEntryId(text, id) {
  return collectEntryIds(text).has(id)
}

module.exports = {
  MCP_CLIENT_MODULE,
  scanPatch,
  readEntry,
  genEntryLines,
  upsertEntry,
  removeEntry,
  setEntryDisabled,
  listMcpEntries,
  collectEntryIds,
  hasEntryId,
}
