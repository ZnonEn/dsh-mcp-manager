'use strict'

/**
 * yaml-mini —— 面向 DSH `cordis.patch.yml` 的最小 YAML 读写实现。
 *
 * 为什么不直接用 `yaml` / `js-yaml`：
 *  1) 插件要求零依赖：profile 的 pnpm 布局下任何 `require` 失败都会让 host 半边
 *     整个加载不出来（用户机器上已经出现过插件装不上的情况）；
 *  2) 写回时必须保留用户自己写的注释与排版 —— 通用库 dump 会把注释全丢掉；
 *  3) 这里只需要覆盖 profile patch 文件里真实出现的结构：映射、块序列、标量。
 *
 * 设计约束：遇到本实现不支持的 YAML 特性（块标量 `|` `>`、锚点 `&` `*`、标签
 * `!!`、多文档 `---`）一律抛错拒绝。宁可不写，也不写坏用户的配置文件。
 */

/** 该行的前导空格数（制表符按 1 列算 —— YAML 不允许制表符缩进，这里只用于报错定位）。 */
function indentOf(line) {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

function isBlank(line) {
  return /^\s*$/.test(line)
}

function isComment(line) {
  return /^\s*#/.test(line)
}

function isTrivia(line) {
  return isBlank(line) || isComment(line)
}

/**
 * 去掉行尾注释（引号感知：`'#a'` 与 `"#b"` 里的 `#` 不是注释起点）。
 * YAML 规定 `#` 只有当它位于行首或前面是空白时才开始注释。
 */
function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") { i++; continue } // '' 是转义的单引号
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

const TRUE_WORDS = new Set(['true', 'True', 'TRUE'])
const FALSE_WORDS = new Set(['false', 'False', 'FALSE'])
const NULL_WORDS = new Set(['null', 'Null', 'NULL', '~', ''])
const INT_RE = /^[-+]?\d+$/
const FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/

/** 解析一个标量（含单/双引号字符串、数字、布尔、null、流式 JSON）。 */
function parseScalar(raw) {
  const s = String(raw).trim()
  if (NULL_WORDS.has(s)) return null
  if (s[0] === "'" && s[s.length - 1] === "'" && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s[0] === '"' && s[s.length - 1] === '"' && s.length >= 2) {
    try {
      return JSON.parse(s)
    } catch {
      throw new Error(`无法解析的双引号字符串: ${s}`)
    }
  }
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  if (INT_RE.test(s)) {
    const n = Number(s)
    return Number.isSafeInteger(n) ? n : s
  }
  if (FLOAT_RE.test(s)) return Number(s)
  if (s[0] === '[' || s[0] === '{') {
    try {
      return JSON.parse(s)
    } catch {
      throw new Error(`无法解析的流式集合（本实现只接受 JSON 风格）: ${s}`)
    }
  }
  if (/^[&*!|>%@`]/.test(s)) {
    throw new Error(`不支持的 YAML 特性（锚点/标签/块标量）: ${s.slice(0, 12)}`)
  }
  return s
}

/** `key: value` / `key:` 的键名判定（URL、Windows 路径不会被误判为键）。 */
function looksLikeKey(body) {
  return /^[^:\s][^:]*?:(?:\s|$)/.test(body)
}

function skipTrivia(lines, i) {
  while (i < lines.length && isTrivia(lines[i])) i++
  return i
}

/**
 * 解析一个同缩进的块（映射或序列）。
 * @returns {{ value: unknown, next: number }}
 */
function parseBlock(lines, start, indent) {
  const i = skipTrivia(lines, start)
  if (i >= lines.length) return { value: null, next: i }
  const raw = stripComment(lines[i]).trimEnd()
  const lead = indentOf(raw)
  if (lead < indent) return { value: null, next: i }
  if (lead > indent) throw new Error(`第 ${i + 1} 行缩进异常：期望 ${indent} 列，实际 ${lead} 列`)
  const body = raw.slice(indent)
  if (body === '-' || body.startsWith('- ')) return parseSequence(lines, i, indent)
  return parseMapping(lines, i, indent)
}

function parseSequence(lines, start, indent) {
  const out = []
  let i = start
  for (;;) {
    i = skipTrivia(lines, i)
    if (i >= lines.length) break
    const raw = stripComment(lines[i]).trimEnd()
    const lead = indentOf(raw)
    if (lead < indent) break
    if (lead > indent) throw new Error(`第 ${i + 1} 行缩进异常：期望 ${indent} 列，实际 ${lead} 列`)
    const body = raw.slice(indent)
    if (body !== '-' && !body.startsWith('- ')) break
    const rest = body.slice(1).trim()

    if (rest === '') {
      const next = skipTrivia(lines, i + 1)
      const childIndent = next < lines.length ? indentOf(stripComment(lines[next]).trimEnd()) : -1
      if (childIndent > indent) {
        const sub = parseBlock(lines, i + 1, childIndent)
        out.push(sub.value)
        i = sub.next
      } else {
        out.push(null)
        i++
      }
    } else if (looksLikeKey(rest)) {
      // `- key: value` —— 把该行改写成纯映射行再递归，缩进取 `- ` 之后第一列的列号。
      const innerIndent = indent + body.indexOf('-') + 2
      const patched = lines.slice()
      patched[i] = ' '.repeat(innerIndent) + rest
      const sub = parseBlock(patched, i, innerIndent)
      out.push(sub.value)
      i = sub.next
    } else {
      out.push(parseScalar(rest))
      i++
    }
  }
  return { value: out, next: i }
}

function parseMapping(lines, start, indent) {
  const obj = {}
  let i = start
  for (;;) {
    i = skipTrivia(lines, i)
    if (i >= lines.length) break
    const raw = stripComment(lines[i]).trimEnd()
    const lead = indentOf(raw)
    if (lead < indent) break
    if (lead > indent) throw new Error(`第 ${i + 1} 行缩进异常：期望 ${indent} 列，实际 ${lead} 列`)
    const body = raw.slice(indent)
    const m = /^([^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(body)
    if (!m) throw new Error(`第 ${i + 1} 行不是合法的 "键: 值"：${body}`)
    const key = m[1].trim()
    const rest = (m[2] ?? '').trim()
    if (rest === '') {
      const next = skipTrivia(lines, i + 1)
      const childIndent = next < lines.length ? indentOf(stripComment(lines[next]).trimEnd()) : -1
      if (childIndent > indent) {
        const sub = parseBlock(lines, i + 1, childIndent)
        obj[key] = sub.value
        i = sub.next
      } else {
        obj[key] = null
        i++
      }
    } else {
      if (/^[|>]/.test(rest)) throw new Error(`不支持块标量（第 ${i + 1} 行）：${rest.slice(0, 8)}`)
      obj[key] = parseScalar(rest)
      i++
    }
  }
  return { value: obj, next: i }
}

/**
 * 解析本实现支持范围内的 YAML 文本。
 * 根节点可以是映射、块序列，或**顶层 flow 集合**（新建 profile 的
 * cordis.patch.yml 默认内容就是一个 `[]`）。文件级注释与空行会被跳过。
 */
function parseYamlSubset(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const i = skipTrivia(lines, 0)
  if (i >= lines.length) return null
  const first = stripComment(lines[i]).trimEnd()
  const firstTrimmed = first.trim()
  if (firstTrimmed[0] === '[' || firstTrimmed[0] === '{') {
    // 顶层 flow 集合：整份文档就是它，后面不允许再有内容
    const value = parseScalar(firstTrimmed)
    const leftoverFlow = skipTrivia(lines, i + 1)
    if (leftoverFlow < lines.length) {
      throw new Error(`第 ${leftoverFlow + 1} 行无法归入任何块，解析中止：${lines[leftoverFlow].trim().slice(0, 40)}`)
    }
    return value
  }
  const indent = indentOf(first)
  const { value, next } = parseBlock(lines, i, indent)
  // 残余的非空行说明文件里有本实现读不懂的并列结构 —— 必须报错而不是静默忽略。
  const leftover = skipTrivia(lines, next)
  if (leftover < lines.length) {
    throw new Error(`第 ${leftover + 1} 行无法归入任何块，解析中止：${lines[leftover].trim().slice(0, 40)}`)
  }
  return value
}

/** 生成安全标量：必要时用单引号包裹（单引号内 `\` 无特殊含义，适合 Windows 路径）。 */
function dumpScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const s = String(value)
  const bare = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(s) &&
    !TRUE_WORDS.has(s) && !FALSE_WORDS.has(s) && !NULL_WORDS.has(s) &&
    !INT_RE.test(s) && !FLOAT_RE.test(s)
  if (bare) return s
  return `'${s.replace(/'/g, "''")}'`
}

/** 把对象/数组 dump 成 YAML 行数组（不写行尾换行）。 */
function dumpYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const lines = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const sub = dumpYaml(item, indent + 2)
        if (sub.length === 0) {
          lines.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`)
        } else {
          lines.push(`${pad}- ${sub[0].slice(indent + 2)}`)
          for (let i = 1; i < sub.length; i++) lines.push(sub[i])
        }
      } else {
        lines.push(`${pad}- ${dumpScalar(item)}`)
      }
    }
    return lines
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && typeof v === 'object') {
        const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0
        if (empty) {
          lines.push(`${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}`)
        } else {
          lines.push(`${pad}${k}:`)
          for (const l of dumpYaml(v, indent + 2)) lines.push(l)
        }
      } else {
        lines.push(`${pad}${k}: ${dumpScalar(v)}`)
      }
    }
    return lines
  }
  return [`${pad}${dumpScalar(value)}`]
}

module.exports = {
  indentOf,
  isBlank,
  isComment,
  isTrivia,
  stripComment,
  parseScalar,
  parseYamlSubset,
  dumpScalar,
  dumpYaml,
  dumpString: dumpScalar,
  looksLikeKey,
}
