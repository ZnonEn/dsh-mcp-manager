'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const y = require('../src/yaml-mini.js')

test('parseYamlSubset：解析真实的 profile patch 片段', () => {
  const text = [
    '# 注释',
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '  config:',
    '    enabled: true',
    '- insert:',
    "    - id: mcp-comfy",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: comfy',
    '        transport: stdio',
    "        command: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe'",
    '        env:',
    "          COMFY_BIN: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe'",
    '        toolCallTimeoutMs: 600000',
    '        failOnStartupError: true',
  ].join('\n')

  const parsed = y.parseYamlSubset(text)
  assert.equal(Array.isArray(parsed), true)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'ui-settings')
  assert.equal(parsed[0].config.enabled, true)
  const mcp = parsed[1].insert[0]
  assert.equal(mcp.id, 'mcp-comfy')
  assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(mcp.config.serverName, 'comfy')
  assert.equal(mcp.config.transport, 'stdio')
  assert.equal(mcp.config.command, 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe')
  assert.equal(mcp.config.env.COMFY_BIN, 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe')
  assert.equal(mcp.config.toolCallTimeoutMs, 600000)
  assert.equal(mcp.config.failOnStartupError, true)
})

test('parseYamlSubset：标量类型与引号', () => {
  const parsed = y.parseYamlSubset([
    "plain: hello world",
    "num: 42",
    "float: 1.5",
    "bool: false",
    "nul: null",
    "quoted: 'a: b # not comment'",
    'dq: "line\\nn2"',
    "hash: value # 行尾注释",
    "url: https://example.com/mcp",
    "winpath: D:\\tools\\x.exe",
    "empty:",
  ].join('\n'))
  assert.equal(parsed.plain, 'hello world')
  assert.equal(parsed.num, 42)
  assert.equal(parsed.float, 1.5)
  assert.equal(parsed.bool, false)
  assert.equal(parsed.nul, null)
  assert.equal(parsed.quoted, 'a: b # not comment')
  assert.equal(parsed.dq, 'line\nn2')
  assert.equal(parsed.hash, 'value')
  assert.equal(parsed.url, 'https://example.com/mcp')
  assert.equal(parsed.winpath, 'D:\\tools\\x.exe')
  assert.equal(parsed.empty, null)
})

test('parseYamlSubset：块序列与流式数组', () => {
  const parsed = y.parseYamlSubset([
    'args:',
    '  - -y',
    '  - "@modelcontextprotocol/server-filesystem"',
    "  - 'D:\\work'",
    'inline: ["a", 1, true]',
    'emptyList: []',
    'emptyMap: {}',
  ].join('\n'))
  assert.deepEqual(parsed.args, ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\work'])
  assert.deepEqual(parsed.inline, ['a', 1, true])
  assert.deepEqual(parsed.emptyList, [])
  assert.deepEqual(parsed.emptyMap, {})
})

test('parseYamlSubset：拒绝不支持的 YAML 特性而不是猜', () => {
  assert.throws(() => y.parseYamlSubset('a: |\n  text\n'), /块标量/)
  assert.throws(() => y.parseYamlSubset('a: !!js/function >\n  x\n'), /块标量/)
})

test('stripComment：只把空白后的 # 当注释', () => {
  assert.equal(y.stripComment('a: "#x" # y').trim(), 'a: "#x"')
  assert.equal(y.stripComment("a: '#x' # y").trim(), "a: '#x'")
  assert.equal(y.stripComment('   # 整行注释').trim(), '')
  assert.equal(y.stripComment('a: b#c').trim(), 'a: b#c')
})

test('dumpYaml / dumpScalar：生成可回读的 YAML', () => {
  const config = {
    serverName: 'comfy',
    transport: 'stdio',
    command: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe',
    args: ['-y', 'pkg name'],
    env: { COMFY_BIN: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe' },
    toolCallTimeoutMs: 600000,
    failOnStartupError: true,
  }
  const lines = y.dumpYaml(config, 0)
  const roundtrip = y.parseYamlSubset(lines.join('\n'))
  assert.deepEqual(roundtrip, config)
})

test('dumpScalar：需要引号的场合会加单引号，且单引号可回读', () => {
  assert.equal(y.dumpScalar('plain'), 'plain')
  assert.equal(y.dumpScalar('true'), "'true'")
  assert.equal(y.dumpScalar('123'), "'123'")
  assert.equal(y.dumpScalar('a: b'), "'a: b'")
  assert.equal(y.dumpScalar("it's"), "'it''s'")
  assert.equal(y.parseScalar(y.dumpScalar("it's")), "it's")
})
