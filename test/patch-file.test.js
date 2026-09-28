'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const pf = require('../src/patch-file.js')
const y = require('../src/yaml-mini.js')

const SAMPLE = [
  '# Your patch layer for this dsh profile',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: dark',
  '- id: web-ui-market',
  '  disabled: true',
  '# 这里有一段用户自己写的说明，不能被插件改坏',
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
  '',
].join('\n')

test('listMcpEntries：只挑出 MCP 客户端条目', () => {
  const entries = pf.listMcpEntries(SAMPLE)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'mcp-comfy')
  assert.equal(entries[0].config.serverName, 'comfy')
  assert.equal(entries[0].config.env.COMFY_BIN, 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe')
  assert.equal(entries[0].parseError, null)
})

test('scanPatch：拿到条目行范围，且周边内容一字不动', () => {
  const scanned = pf.scanPatch(SAMPLE)
  assert.equal(scanned.entries.length, 1)
  const entry = scanned.entries[0]
  const block = scanned.lines.slice(entry.start, entry.end).join('\n')
  assert.match(block, /- id: mcp-comfy/)
  assert.match(block, /failOnStartupError: true/)
  // 条目范围之外的内容保持不变
  const before = scanned.lines.slice(0, entry.start).join('\n')
  assert.match(before, /# 这里有一段用户自己写的说明，不能被插件改坏/)
  assert.match(before, /web-ui-market/)
})

test('upsertEntry：新增条目 → 追加进已有 insert 块，注释与其它条目不变', () => {
  const next = pf.upsertEntry(SAMPLE, {
    id: 'mcp-files',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'server'], cwd: 'D:\\work' },
  })
  assert.equal(next.action, 'appended')
  assert.match(next.text, /- id: mcp-files/)
  assert.match(next.text, /# 这里有一段用户自己写的说明，不能被插件改坏/)
  assert.match(next.text, /preference: dark/)
  const entries = pf.listMcpEntries(next.text)
  assert.equal(entries.length, 2)
  const added = entries.find((e) => e.id === 'mcp-files')
  assert.deepEqual(added.config.args, ['-y', 'server'])
  assert.equal(added.config.cwd, 'D:\\work')
  // 幂等性：重复写入不再增加条目
  const again = pf.upsertEntry(next.text, {
    id: 'mcp-files',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'files', transport: 'stdio', command: 'npx' },
  })
  assert.equal(again.action, 'updated')
  assert.equal(pf.listMcpEntries(again.text).length, 2)
})

test('upsertEntry：编辑已有条目（改成 http 传输）', () => {
  const next = pf.upsertEntry(SAMPLE, {
    id: 'mcp-comfy',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'comfy',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9000/mcp',
      headers: { Authorization: 'Bearer abc' },
    },
  })
  assert.equal(next.action, 'updated')
  const entries = pf.listMcpEntries(next.text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].config.transport, 'streamable-http')
  assert.equal(entries[0].config.url, 'http://127.0.0.1:9000/mcp')
  assert.equal(entries[0].config.headers.Authorization, 'Bearer abc')
  assert.equal(entries[0].config.command, undefined)
  // 其它顶层条目还在
  assert.match(next.text, /- id: ui-theme/)
  assert.match(next.text, /- id: web-ui-market/)
})

test('upsertEntry：文件里没有 insert 块时新建一个', () => {
  const bare = ['- id: ui-theme', '  config:', '    preference: dark', ''].join('\n')
  const next = pf.upsertEntry(bare, {
    id: 'mcp-demo',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'demo', transport: 'stdio', command: 'node' },
  })
  assert.equal(next.action, 'created-insert')
  assert.match(next.text, /\n- insert:\n {4}- id: mcp-demo/)
  const parsed = pf.listMcpEntries(next.text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].config.serverName, 'demo')
})

test('removeEntry：删除条目；块空了连 insert 块一起删掉', () => {
  const next = pf.removeEntry(SAMPLE, 'mcp-comfy')
  assert.equal(next.removed, true)
  assert.equal(pf.listMcpEntries(next.text).length, 0)
  assert.equal(/- insert:/.test(next.text), false)
  assert.match(next.text, /- id: ui-theme/)
  assert.match(next.text, /# 这里有一段用户自己写的说明，不能被插件改坏/)
  // 删不存在的条目不动文件
  const noop = pf.removeEntry(SAMPLE, 'mcp-nope')
  assert.equal(noop.removed, false)
  assert.equal(noop.text, SAMPLE)
})

test('removeEntry：同块还有其它条目时只删目标条目', () => {
  const two = pf.upsertEntry(SAMPLE, {
    id: 'mcp-second',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'second', transport: 'stdio', command: 'node' },
  }).text
  const next = pf.removeEntry(two, 'mcp-comfy')
  const entries = pf.listMcpEntries(next.text)
  assert.deepEqual(entries.map((e) => e.id), ['mcp-second'])
  assert.match(next.text, /- insert:/)
})

test('setEntryDisabled：写入与清除 disabled 键', () => {
  const off = pf.setEntryDisabled(SAMPLE, 'mcp-comfy', true)
  assert.equal(off.changed, true)
  assert.match(off.text, /\n {6}disabled: true\n/)
  assert.equal(pf.listMcpEntries(off.text)[0].disabled, true)
  // 重复设置不再改动
  assert.equal(pf.setEntryDisabled(off.text, 'mcp-comfy', true).changed, false)
  const on = pf.setEntryDisabled(off.text, 'mcp-comfy', false)
  assert.equal(on.changed, true)
  assert.equal(pf.listMcpEntries(on.text)[0].disabled, false)
  assert.match(on.text, /serverName: comfy/)
})

test('CRLF 文件保持 CRLF；解析结果一致', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  const entries = pf.listMcpEntries(crlf)
  assert.equal(entries.length, 1)
  const next = pf.setEntryDisabled(crlf, 'mcp-comfy', true)
  assert.match(next.text, /\r\n {6}disabled: true\r\n/)
})

test('hasEntryId：跨模块查重（避免 id 冲突）', () => {
  assert.equal(pf.hasEntryId(SAMPLE, 'mcp-comfy'), true)
  assert.equal(pf.hasEntryId(SAMPLE, 'mcp-other'), false)
  assert.equal(pf.hasEntryId(SAMPLE, 'ui-theme'), true) // 顶层条目也算占用
})

test('空 profile 文件（顶层 []）：原地展开，不产生非法 YAML', () => {
  // 新建 profile 的 cordis.patch.yml 长这样：注释 + 一个空的 flow 数组
  const bare = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries',
    '[]',
    '',
  ].join('\n')
  const added = pf.upsertEntry(bare, {
    id: 'mcp-first',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'first', transport: 'stdio', command: 'node' },
  })
  assert.equal(added.action, 'created-insert')
  assert.equal(/\[\]/.test(added.text), false, '不能留下孤立的 []')
  // 生成的文件必须仍是合法的 YAML 数组
  const parsed = y.parseYamlSubset(added.text)
  assert.equal(Array.isArray(parsed), true)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].insert[0].id, 'mcp-first')
  assert.equal(pf.listMcpEntries(added.text).length, 1)
  assert.match(added.text, /# Your patch layer for this dsh profile/)

  // 再把这唯一的条目删掉：文件应回到「合法的空数组」而不是空文档
  const back = pf.removeEntry(added.text, 'mcp-first')
  assert.equal(back.removed, true)
  assert.equal(pf.listMcpEntries(back.text).length, 0)
  assert.equal(y.parseYamlSubset(back.text).length, 0)
  assert.match(back.text, /^\[\]$/m)
})

test('空 flow 数组（[ ] 带空格）同样被识别', () => {
  const bare = '# c\n[ ]\n'
  const added = pf.upsertEntry(bare, {
    id: 'mcp-x',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'x', transport: 'stdio', command: 'node' },
  })
  assert.equal(added.action, 'created-insert')
  assert.equal(/\[\s*\]/.test(added.text), false)
  assert.equal(pf.listMcpEntries(added.text).length, 1)
})
