'use strict'

/**
 * validate —— MCP 服务器配置的校验与规范化。
 *
 * 字段与默认值全部对齐已安装的 `@deepseek-ai/dsh-mcp-client`（0.1.7-rc.2）
 * 的 Schemastery schema：
 *   serverName 必须匹配 [A-Za-z0-9_-]{1,32} 且在本 profile 内唯一；
 *   stdio 要 command，streamable-http 要 url；
 *   args/env/cwd/toolCallTimeoutMs/failOnStartupError/maxInstructionBytes/reconnect 都有默认值，
 *   所以「用户没填」的字段一律**不写进文件**，交给插件用官方默认值。
 */

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const ENTRY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/
const TIMEOUT_MIN = 1000
const TIMEOUT_MAX = 24 * 60 * 60 * 1000
const DEFAULT_MAX_INSTRUCTION_BYTES = 32768

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normString(v) {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim()
}

/** 接受数组、`KEY=VALUE` 文本或对象，统一成 string→string 映射。 */
function normalizeDict(input, label, errors) {
  const out = {}
  if (input === null || input === undefined || input === '') return out
  if (Array.isArray(input)) {
    for (const raw of input) {
      const s = normString(raw)
      if (s === '') continue
      const idx = s.indexOf('=')
      if (idx <= 0) {
        errors.push(`${label} 的每一项都要写成 KEY=VALUE：${s}`)
        continue
      }
      out[s.slice(0, idx).trim()] = s.slice(idx + 1)
    }
    return out
  }
  if (typeof input === 'string') {
    for (const line of input.split(/\r?\n/)) {
      const s = line.trim()
      if (s === '' || s.startsWith('#')) continue
      const idx = s.indexOf('=')
      if (idx <= 0) {
        errors.push(`${label} 的每一项都要写成 KEY=VALUE：${s}`)
        continue
      }
      out[s.slice(0, idx).trim()] = s.slice(idx + 1)
    }
    return out
  }
  if (isPlainObject(input)) {
    for (const [k, v] of Object.entries(input)) {
      const key = normString(k)
      if (key === '') continue
      out[key] = v === null || v === undefined ? '' : String(v)
    }
    return out
  }
  errors.push(`${label} 格式无法识别`)
  return out
}

/** 接受数组或按行文本，统一成字符串数组（忽略空行）。 */
function normalizeList(input) {
  if (Array.isArray(input)) return input.map((v) => normString(v)).filter((v) => v !== '')
  if (typeof input === 'string') {
    return input
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter((v) => v !== '' && !v.startsWith('#'))
  }
  return []
}

function normalizeIntent(input) {
  const out = {}
  if (!isPlainObject(input)) return out
  if (input.enabled !== undefined && input.enabled !== null && input.enabled !== '') out.enabled = !!input.enabled
  for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts']) {
    const v = input[key]
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    out[key] = Number.isFinite(n) ? n : NaN
  }
  return out
}

/**
 * @param {object} input 表单/接口提交的原始数据
 * @param {{ reservedIds?: string[], originalId?: string }} [opts]
 *        reservedIds：本 profile 已被占用的 insert 条目 id（用于查重，可含 originalId）
 * @returns {{ ok: boolean, errors: string[], value?: {id: string, serverName: string, config: object} }}
 */
function validateServer(input, opts = {}) {
  const errors = []
  const reserved = new Set(opts.reservedIds || [])
  if (opts.originalId) reserved.delete(opts.originalId)

  const serverName = normString(input && input.serverName)
  const originalName = normString(opts.originalServerName)
  const reservedNames = (opts.reservedServerNames || []).filter((n) => typeof n === 'string' && n !== '')
  if (serverName === '') errors.push('服务器名称（serverName）不能为空')
  else if (!SERVER_NAME_RE.test(serverName)) {
    errors.push('服务器名称只能包含字母、数字、下划线、连字符，长度 1–32（它会进入工具名 mcp__<名称>__<工具>）')
  } else if (reservedNames.indexOf(serverName) >= 0 && serverName !== originalName) {
    errors.push(`服务器名称「${serverName}」已被另一个 MCP 服务器占用，请换一个（工具名前缀必须唯一）`)
  }

  const transport = normString(input && input.transport) || 'stdio'
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    errors.push('传输方式只能是 stdio 或 streamable-http')
  }

  let id = normString(input && input.id)
  if (id === '') id = serverName ? `mcp-${serverName}` : ''
  if (id !== '' && !ENTRY_ID_RE.test(id)) {
    errors.push('条目 ID 只能包含字母、数字、下划线、连字符、点，长度 1–64')
  }
  if (id !== '' && reserved.has(id)) {
    errors.push(`条目 ID「${id}」已被同一 profile 里的其它插件条目占用，请换一个`)
  }

  const config = { serverName, transport }

  if (transport === 'stdio') {
    const command = normString(input && input.command)
    if (command === '') errors.push('stdio 传输必须填写启动命令（command），例如 node 或某个 .exe 路径')
    if (command !== '') config.command = command
    const args = normalizeList(input && input.args)
    if (args.length > 0) config.args = args
    const env = normalizeDict(input && input.env, '环境变量', errors)
    if (Object.keys(env).length > 0) config.env = env
    const cwd = normString(input && input.cwd)
    if (cwd !== '') config.cwd = cwd
  } else {
    const url = normString(input && input.url)
    if (url === '') errors.push('streamable-http 传输必须填写服务地址（url）')
    else if (!/^https?:\/\/\S+$/i.test(url)) errors.push('服务地址必须以 http:// 或 https:// 开头')
    if (url !== '') config.url = url
    const headers = normalizeDict(input && input.headers, '请求头', errors)
    if (Object.keys(headers).length > 0) config.headers = headers
  }

  const timeoutRaw = input && input.toolCallTimeoutMs
  if (timeoutRaw !== undefined && timeoutRaw !== null && timeoutRaw !== '') {
    const n = Number(timeoutRaw)
    if (!Number.isInteger(n) || n < TIMEOUT_MIN || n > TIMEOUT_MAX) {
      errors.push(`工具调用超时必须是 ${TIMEOUT_MIN}–${TIMEOUT_MAX} 之间的整数毫秒`)
    } else {
      config.toolCallTimeoutMs = n
    }
  }

  if (input && input.failOnStartupError === true) config.failOnStartupError = true

  const maxInstructionRaw = input && input.maxInstructionBytes
  if (maxInstructionRaw !== undefined && maxInstructionRaw !== null && maxInstructionRaw !== '') {
    const n = Number(maxInstructionRaw)
    if (!Number.isInteger(n) || n < 1) errors.push('maxInstructionBytes 必须是正整数')
    else if (n !== DEFAULT_MAX_INSTRUCTION_BYTES) config.maxInstructionBytes = n
  }

  const reconnect = normalizeIntent(input && input.reconnect)
  const reconnectKeys = Object.keys(reconnect)
  if (reconnectKeys.length > 0) {
    const policy = {}
    for (const [k, v] of Object.entries(reconnect)) {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        errors.push(`重连策略的 ${k} 必须是数字`)
      } else {
        policy[k] = v
      }
    }
    if (Object.keys(policy).length > 0) config.reconnect = policy
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], value: { id, serverName, config } }
}

module.exports = {
  SERVER_NAME_RE,
  ENTRY_ID_RE,
  DEFAULT_MAX_INSTRUCTION_BYTES,
  validateServer,
  normalizeDict,
  normalizeList,
}
