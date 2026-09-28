'use strict'

/**
 * patch-file —— 读写 DSH profile 的 `cordis.patch.yml`，只做行级增删改。
 *
 * 关键取舍：**不做整文件重排**。所有写操作都只替换/插入/删除"本次要动的那个
 * 条目"的行范围，其余内容（包括用户自己写的注释、`!!js` 表达式、其它插件的
 * 配置）逐字节保持原样。这样即使用户的 patch 文件里有本实现看不懂的结构，
 * 也不会被写坏。
 */

const { indentOf, isComment, stripComment, parseScalar, parseYamlSubset, dumpScalar, dumpYaml } = require('./yaml-mini.js')

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

/**
 * 取顶层项的第一个键（`- key: value` / `- key:`）。
 * 这是区分「独立 insert 块」与「组定向 insert」的唯一依据：
 *   - insert:            ← 首键是 insert：可追加的独立 insert 块
 *   - id: my-group       ← 首键是 id，内部可能还有 `insert:`：
 *     insert:                官方 applyEntryPatches 支持把它追加进 id 指定的 group，
 *                            本插件不识别、不改写它。
 */
function topItemHead(line) {
  const raw = stripComment(line).trimEnd()
  if (raw === '') return null
  const lead = indentOf(raw)
  const body = raw.slice(lead)
  if (body !== '-' && !body.startsWith('- ')) return null
  const rest = body.slice(1).trim()
  if (rest === '') return null
  const m = /^([^:\s][^:]*?)\s*:(?:\s*(.*))?$/.exec(rest)
  if (!m) return null
  return { key: m[1].trim(), inlineValue: (m[2] === undefined ? '' : m[2].trim()) }
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
    // 只认「顶层项的第一个键就是 insert」的独立 insert 块。
    // 组定向插入（`- id: group` 内部再写 `insert:`）是另一种合法结构（官方
    // dsh-app-boot 的 applyEntryPatches 会把它追加进 id 指定的 group 条目），
    // 一旦把它误当成追加目标，生成的行会落在错误缩进上、写出非法 YAML。
    const head = topItemHead(lines[block.start])
    if (!head || head.key !== 'insert') continue

    const itemIndent = detectChildIndent(lines, block.start + 1, block.end)
    if (itemIndent < 0) {
      inserts.push({
        blockStart: block.start,
        blockEnd: block.end,
        itemIndent: 4,
        insertEnd: block.end,
        inlineValue: head.inlineValue,
      })
      continue
    }

    let insertEnd = block.start + 1
    for (let i = block.start + 1; i < block.end; i++) {
      const raw = stripComment(lines[i]).trimEnd()
      if (raw === '' || isComment(lines[i])) continue
      if (indentOf(raw) !== itemIndent) continue
      const body = raw.slice(itemIndent)
      if (body !== '-' && !body.startsWith('- ')) continue

      // 条目结束行 = 最后一个内容行的下一行。尾部的空行/注释**不**算条目的一部分，
      // 否则编辑条目会把用户写在它下面的注释一起删掉。
      let j = i + 1
      let lastContent = i
      for (; j < block.end; j++) {
        const r2 = stripComment(lines[j]).trimEnd()
        if (r2 === '' || isComment(lines[j])) continue
        if (indentOf(r2) <= itemIndent) break
        lastContent = j
      }
      const keyIndent = itemIndent + Math.max(2, body.indexOf('-') + 2)
      const entry = readEntry(lines, { start: i, end: lastContent + 1 }, itemIndent, keyIndent)
      entries.push(entry)
      insertEnd = j // 追加位置仍然跳过尾部 trivia（新条目排在已有注释之后）
      i = j - 1
    }
    inserts.push({
      blockStart: block.start,
      blockEnd: block.end,
      itemIndent,
      insertEnd,
      inlineValue: head.inlineValue,
    })
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
  // 只追加到「值写在下面各行的独立 insert 块」（`- insert:` 后面没有内联值）。
  // `- insert: []` 这类内联写法不能再往里塞行，否则同样会写出非法 YAML。
  const target = scanned.inserts.filter((b) => b.inlineValue === '').pop()
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
  // 保留文件原有的结尾空行风格：先摘掉尾部空行、插入后再按原样补回，
  // 这样「新增 → 删除」能回到与原文**字节相等**的状态。
  const trailing = []
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') trailing.push(lines.pop())
  lines.push('', '- insert:', ...gen)
  for (let i = 0; i < trailing.length; i++) lines.push(trailing[i])
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
  let result = lines.join(scanned.lineEnding)
  // 顺带清掉针对该 id 的顶层启用状态覆盖项，别留下指向已删除条目的残渣
  const cleaned = setEntryDisabled(result, id, false)
  if (cleaned.changed) result = cleaned.text
  return { text: result, removed: true }
}

/**
 * 写/清「顶层 `- id: X` + `disabled: true`」启用状态覆盖项。
 *
 * 为什么必须用这个形式：DSH 官方 `pluginManager.writePluginEnabled` 只在**不含 insert
 * 的顶层项**里按 id 匹配，匹配不到就新加一个顶层项 —— 也就是说，对 `- insert:` 内部的
 * MCP 条目，官方把状态记在顶层，往条目内部塞 `disabled:` 键它并不认（实测 toggle 后
 * 文件毫无变化）。用同一种形式，界面显示与 DSH 实际行为才会一致。
 *
 * @returns {{ text: string, changed: boolean }}
 */
function setEntryDisabled(text, id, disabled) {
  const scanned = scanPatch(text)
  const lines = scanned.lines.slice()

  let target = null
  for (const block of scanTopLevelBlocks(lines)) {
    const head = topItemHead(lines[block.start])
    if (!head || head.key !== 'id') continue
    if (blockHasInsertKey(lines, block)) continue
    if (parseScalar(head.inlineValue) !== id) continue
    target = block
    break
  }

  const findDisabledLine = (block) => {
    if (!block) return -1
    for (let i = block.start + 1; i < block.end; i++) {
      const raw = stripComment(lines[i]).trimEnd()
      if (raw === '' || isComment(lines[i])) continue
      if (indentOf(raw) !== 2) continue
      if (/^disabled\s*:/.test(raw.slice(2))) return i
    }
    return -1
  }

  if (disabled) {
    if (target) {
      const at = findDisabledLine(target)
      if (at >= 0) {
        if (stripComment(lines[at]).trimEnd().slice(2).trim() === 'disabled: true') {
          return { text: String(text), changed: false }
        }
        lines[at] = '  disabled: true'
      } else {
        lines.splice(target.start + 1, 0, '  disabled: true')
      }
      return { text: lines.join(scanned.lineEnding), changed: true }
    }
    // 官方同款：新加一个顶层覆盖项（保留文件原有的结尾空行风格）
    const trailing = []
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') trailing.push(lines.pop())
    lines.push(`- id: ${dumpScalar(id)}`, '  disabled: true')
    for (let i = 0; i < trailing.length; i++) lines.push(trailing[i])
    return { text: lines.join(scanned.lineEnding), changed: true }
  }

  // disabled = false：清掉这个覆盖项
  if (!target) return { text: String(text), changed: false }
  const at = findDisabledLine(target)
  if (at < 0) return { text: String(text), changed: false }
  if (countBlockKeys(lines, target) <= 1) {
    // 该项只有 id + disabled（官方新增的那种），整项删除
    lines.splice(target.start, target.end - target.start)
  } else {
    lines.splice(at, 1)
  }
  return { text: lines.join(scanned.lineEnding), changed: true }
}

/**
 * 顶层项里是否含 `insert:` 键（组定向 insert 或独立 insert 块）。
 * 官方 writePluginEnabled 只把「不含 insert 的顶层项」当作禁用状态的目标。
 */
function blockHasInsertKey(lines, block) {
  for (let i = block.start; i < block.end; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '' || isComment(lines[i])) continue
    if (indentOf(raw) !== 2) continue
    if (/^insert\s*:/.test(raw.slice(2))) return true
  }
  return false
}

/**
 * 收集「顶层 `- id: X` + `disabled:`」形式的启用状态覆盖。
 *
 * 这是 DSH 官方的持久化形式 —— `@deepseek-ai/dsh-plugin-manager` 的 writePluginEnabled
 * 只在**不含 insert 的顶层项**里按 id 匹配，匹配不到就新加一个顶层项。
 * 也就是说：对 `- insert:` 内部那些 MCP 条目，停用状态是记在**顶层**的，
 * 而不是写在条目自己的 `disabled:` 键上。
 * @returns {Map<string, boolean>}
 */
function topLevelDisabledState(text) {
  const scanned = scanPatch(text)
  const lines = scanned.lines
  const map = new Map()
  for (const block of scanTopLevelBlocks(lines)) {
    const head = topItemHead(lines[block.start])
    if (!head || head.key !== 'id') continue
    if (blockHasInsertKey(lines, block)) continue
    const id = parseScalar(head.inlineValue)
    if (typeof id !== 'string' || id === '') continue
    let disabled = null
    for (let i = block.start + 1; i < block.end; i++) {
      const raw = stripComment(lines[i]).trimEnd()
      if (raw === '' || isComment(lines[i])) continue
      if (indentOf(raw) !== 2) continue
      const m = /^disabled\s*:\s*(.*)$/.exec(raw.slice(2))
      if (m) disabled = /^(true|True|TRUE)$/.test(m[1].trim())
    }
    if (disabled !== null) map.set(id, disabled)
  }
  return map
}

/** 统计块内第 2 列的键行数（判断顶层项是不是"只有 id 与 disabled"）。 */
function countBlockKeys(lines, block) {
  let n = 0
  for (let i = block.start + 1; i < block.end; i++) {
    const raw = stripComment(lines[i]).trimEnd()
    if (raw === '' || isComment(lines[i])) continue
    if (indentOf(raw) === 2) n++
  }
  return n
}

/** 取出当前文件里所有 MCP 服务器条目（按模块名过滤），disabled 合并顶层覆盖。 */
function listMcpEntries(text, moduleName = MCP_CLIENT_MODULE) {
  const scanned = scanPatch(text)
  const topDisabled = topLevelDisabledState(text)
  return scanned.entries
    .filter((e) => e.moduleName === moduleName)
    .map((e) => {
      const top = e.id !== null && topDisabled.has(e.id) ? topDisabled.get(e.id) : null
      return {
        id: e.id,
        moduleName: e.moduleName,
        disabled: e.disabled || top === true,
        // 停用状态记在哪：条目自己（entry）还是顶层覆盖项（top-level）
        disabledSource: e.disabled ? 'entry' : (top === true ? 'top-level' : null),
        config: e.config,
        parseError: e.parseError,
      }
    })
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

/**
 * 写盘后的结构自检：确认这份文本里，目标条目位于一个「独立的 `- insert:` 块」内，
 * 且缩进与块内子项一致。
 *
 * 为什么需要它：光看"条目能不能被解析出来"是不够的 —— 即使整个文件已经被写坏
 * （例如追加到了错误缩进上），`listMcpEntries` 依然能读出条目且 parseError 为 null。
 * 而 DSH 对无法解析的 profile patch 是**启动期硬失败**（"must fail loud at boot"），
 * 所以这一关必须挡住，写入方拿到 ok:false 就回滚。
 *
 * @returns {{ ok: boolean, problem?: string }}
 */
function assertSafePatch(text, entryId) {
  const scanned = scanPatch(text)
  if (entryId) {
    const entry = scanned.entries.find((e) => e.id === entryId)
    if (!entry) return { ok: false, problem: `写入后文件里找不到条目 ${entryId}` }
    const block = scanned.inserts.find((b) => entry.start >= b.blockStart && entry.start < b.blockEnd)
    if (!block) return { ok: false, problem: `条目 ${entryId} 不在任何独立的 insert 块内` }
    if (block.inlineValue !== '') {
      return { ok: false, problem: `条目 ${entryId} 落在了带内联值的 insert 块里（第 ${block.blockStart + 1} 行）` }
    }
    if (entry.itemIndent !== block.itemIndent) {
      return { ok: false, problem: `条目 ${entryId} 的缩进（${entry.itemIndent}）与所在 insert 块不一致（${block.itemIndent}）` }
    }
  }
  for (const block of scanned.inserts) {
    const raw = stripComment(scanned.lines[block.blockStart]).trimEnd()
    if (indentOf(raw) !== 0) {
      return { ok: false, problem: `insert 块不在顶层（第 ${block.blockStart + 1} 行缩进 ${indentOf(raw)}）` }
    }
    if (block.itemIndent <= 0) {
      return { ok: false, problem: `insert 块的子项缩进非法（第 ${block.blockStart + 1} 行）` }
    }
  }
  return { ok: true }
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
  topItemHead,
  topLevelDisabledState,
  assertSafePatch,
}
