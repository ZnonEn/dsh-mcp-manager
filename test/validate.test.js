'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { validateServer } = require('../src/validate.js')

test('stdio：合法配置只保留用户填过的字段', () => {
  const res = validateServer({
    serverName: 'comfy',
    transport: 'stdio',
    command: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe',
    args: '-y\npkg\n\n# 注释行会被忽略',
    env: 'COMFY_BIN=D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe\nEMPTY=',
    cwd: 'D:\\work',
    toolCallTimeoutMs: '600000',
    failOnStartupError: true,
  })
  assert.equal(res.ok, true, JSON.stringify(res.errors))
  assert.equal(res.value.id, 'mcp-comfy')
  assert.deepEqual(res.value.config, {
    serverName: 'comfy',
    transport: 'stdio',
    command: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe',
    args: ['-y', 'pkg'],
    env: { COMFY_BIN: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe', EMPTY: '' },
    cwd: 'D:\\work',
    toolCallTimeoutMs: 600000,
    failOnStartupError: true,
  })
})

test('stdio：缺 command、serverName 非法都报错', () => {
  const noCmd = validateServer({ serverName: 'demo', transport: 'stdio' })
  assert.equal(noCmd.ok, false)
  assert.match(noCmd.errors.join('|'), /command/)

  const badName = validateServer({ serverName: 'demo server!', transport: 'stdio', command: 'node' })
  assert.equal(badName.ok, false)
  assert.match(badName.errors.join('|'), /服务器名称/)

  const tooLong = validateServer({ serverName: 'x'.repeat(33), transport: 'stdio', command: 'node' })
  assert.equal(tooLong.ok, false)
})

test('streamable-http：必须 http(s) url', () => {
  const ok = validateServer({ serverName: 'remote', transport: 'streamable-http', url: 'https://example.com/mcp', headers: 'Authorization=Bearer x' })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.deepEqual(ok.value.config, {
    serverName: 'remote',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer x' },
  })

  const missing = validateServer({ serverName: 'remote', transport: 'streamable-http' })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join('|'), /url/)

  const badScheme = validateServer({ serverName: 'remote', transport: 'streamable-http', url: 'ftp://x/y' })
  assert.equal(badScheme.ok, false)
})

test('布尔与数值边界', () => {
  const badTimeout = validateServer({ serverName: 'a', transport: 'stdio', command: 'node', toolCallTimeoutMs: '10' })
  assert.equal(badTimeout.ok, false)
  const floatTimeout = validateServer({ serverName: 'a', transport: 'stdio', command: 'node', toolCallTimeoutMs: '1.5' })
  assert.equal(floatTimeout.ok, false)
  // failOnStartupError=false 是官方默认值，不写进文件
  const cleared = validateServer({ serverName: 'a', transport: 'stdio', command: 'node', failOnStartupError: false })
  assert.equal(cleared.ok, true)
  assert.equal('failOnStartupError' in cleared.value.config, false)
  // maxInstructionBytes 等于默认 32768 时省略
  const def = validateServer({ serverName: 'a', transport: 'stdio', command: 'node', maxInstructionBytes: '32768' })
  assert.equal('maxInstructionBytes' in def.value.config, false)
  const custom = validateServer({ serverName: 'a', transport: 'stdio', command: 'node', maxInstructionBytes: '1024' })
  assert.equal(custom.value.config.maxInstructionBytes, 1024)
})

test('reconnect：只在用户配置时写入', () => {
  const none = validateServer({ serverName: 'a', transport: 'stdio', command: 'node' })
  assert.equal('reconnect' in none.value.config, false)

  const custom = validateServer({
    serverName: 'a',
    transport: 'stdio',
    command: 'node',
    reconnect: { enabled: true, initialDelayMs: '1000', maxAttempts: '3' },
  })
  assert.equal(custom.ok, true, JSON.stringify(custom.errors))
  assert.deepEqual(custom.value.config.reconnect, { enabled: true, initialDelayMs: 1000, maxAttempts: 3 })

  const bad = validateServer({
    serverName: 'a',
    transport: 'stdio',
    command: 'node',
    reconnect: { maxAttempts: 'abc' },
  })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('|'), /maxAttempts/)
})

test('id 与 serverName 查重', () => {
  const dupId = validateServer(
    { id: 'mcp-comfy', serverName: 'other', transport: 'stdio', command: 'node' },
    { reservedIds: ['mcp-comfy'] },
  )
  assert.equal(dupId.ok, false)
  assert.match(dupId.errors.join('|'), /已被同一 profile/)

  // 编辑自己时不该被自己挡住（调用方把 originalServerName 一起传进来）
  const selfEdit = validateServer(
    { id: 'mcp-comfy', serverName: 'comfy', transport: 'stdio', command: 'node' },
    { reservedIds: ['mcp-comfy'], originalId: 'mcp-comfy', reservedServerNames: ['comfy'], originalServerName: 'comfy' },
  )
  assert.equal(selfEdit.ok, true, JSON.stringify(selfEdit.errors))

  const dupName = validateServer(
    { serverName: 'comfy', transport: 'stdio', command: 'node' },
    { reservedServerNames: ['comfy'] },
  )
  assert.equal(dupName.ok, false)
  assert.match(dupName.errors.join('|'), /已被另一个 MCP 服务器/)
})
