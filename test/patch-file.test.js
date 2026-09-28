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

test('setEntryDisabled：写/清顶层覆盖项（与 DSH 官方 writePluginEnabled 同款形式）', () => {
  const off = pf.setEntryDisabled(SAMPLE, 'mcp-comfy', true)
  assert.equal(off.changed, true)
  assert.match(off.text, /^- id: mcp-comfy\n {2}disabled: true$/m)
  assert.equal(pf.listMcpEntries(off.text)[0].disabled, true)
  assert.equal(pf.listMcpEntries(off.text)[0].disabledSource, 'top-level')
  // 幂等
  assert.equal(pf.setEntryDisabled(off.text, 'mcp-comfy', true).changed, false)
  const on = pf.setEntryDisabled(off.text, 'mcp-comfy', false)
  assert.equal(on.changed, true)
  assert.equal(pf.listMcpEntries(on.text)[0].disabled, false)
  // 只剩 id + disabled 的覆盖项整项删除；insert 里的条目本身不能动
  assert.equal(/^- id: mcp-comfy$/m.test(on.text), false)
  assert.match(on.text, /^ {4}- id: mcp-comfy$/m)
  assert.match(on.text, /serverName: comfy/)
})

test('removeEntry：顺带清掉指向它的顶层 disabled 覆盖项', () => {
  const off = pf.setEntryDisabled(SAMPLE, 'mcp-comfy', true).text
  const removed = pf.removeEntry(off, 'mcp-comfy')
  assert.equal(removed.removed, true)
  assert.equal(/- id: mcp-comfy/.test(removed.text), false)
  // 针对它的顶层覆盖项被清掉，但样例里别的条目（web-ui-market）自己的 disabled 不受影响
  assert.match(removed.text, /- id: web-ui-market\n {2}disabled: true/)
})

test('条目内部的 disabled 键仍被识别（兼容用户手写的旧形式）', () => {
  const inside = SAMPLE.replace(
    '        failOnStartupError: true',
    '        failOnStartupError: true\n      disabled: true', // 条目头部的键（6 空格）
  )
  assert.equal(pf.listMcpEntries(inside)[0].disabled, true)
  assert.equal(pf.listMcpEntries(inside)[0].disabledSource, 'entry')
  assert.equal(pf.assertSafePatch(inside, 'mcp-comfy').ok, true)
})

test('CRLF 文件保持 CRLF；解析结果一致', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  const entries = pf.listMcpEntries(crlf)
  assert.equal(entries.length, 1)
  const next = pf.setEntryDisabled(crlf, 'mcp-comfy', true)
  assert.match(next.text, /\r\n- id: mcp-comfy\r\n {2}disabled: true\r\n/)
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

// —— 回归：独立审查发现的三个真实缺陷 ——

test('回归：组定向 insert（`- id: group` + `insert:`）不能被当作追加目标', () => {
  // 官方 dsh-app-boot 的 applyEntryPatches 支持 {id, insert}：把 insert 追加进 id 指定的 group。
  // 这种结构里也含 `insert:` 字样，但**不是**独立 insert 块；往里追加会写出非法 YAML（DSH 启动硬失败）。
  const grouped = [
    '- id: my-group',
    "  name: '@deepseek-ai/dsh-whatever'",
    '  insert:',
    '    - id: child-a',
    "      name: '@deepseek-ai/dsh-child'",
    '',
  ].join('\n')

  const scanned = pf.scanPatch(grouped)
  assert.equal(scanned.inserts.length, 0, '组定向 insert 不应被识别为独立 insert 块')
  assert.equal(pf.listMcpEntries(grouped).length, 0)

  const next = pf.upsertEntry(grouped, {
    id: 'mcp-new',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'new', transport: 'stdio', command: 'node' },
  })
  // 新条目必须落在**新建的独立顶层 insert 块**里（缩进 4），而不是插进组定向结构内部
  const newLine = next.text.split('\n').find((l) => l.includes('- id: mcp-new'))
  assert.equal(newLine, '    - id: mcp-new')
  // 原有结构一字未动
  assert.match(next.text, /- id: my-group/)
  assert.match(next.text, /    - id: child-a/)
  assert.deepEqual(pf.assertSafePatch(next.text, 'mcp-new'), { ok: true })
  assert.equal(pf.listMcpEntries(next.text).length, 1)
})

test('回归：编辑条目不会吃掉紧跟其后的注释（尾部 trivia 不属于条目行范围）', () => {
  const text = [
    '- insert:',
    '    - id: mcp-a',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: a',
    '        transport: stdio',
    '        command: node',
    '    # 这是用户写在条目 a 下面的注释',
    '',
    '    - id: mcp-b',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: b',
    '        transport: stdio',
    '        command: node',
    '# 顶层注释：下面是别的插件',
    '',
  ].join('\n')

  const edited = pf.upsertEntry(text, {
    id: 'mcp-a',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'a', transport: 'stdio', command: 'node', args: ['--x'] },
  })
  assert.match(edited.text, /# 这是用户写在条目 a 下面的注释/, '条目后的注释必须保留')
  assert.match(edited.text, /# 顶层注释：下面是别的插件/, '顶层注释必须保留')
  const entries = pf.listMcpEntries(edited.text)
  assert.deepEqual(entries.find((e) => e.id === 'mcp-a').config.args, ['--x'])
  assert.equal(entries.find((e) => e.id === 'mcp-b').config.serverName, 'b')
  // 行范围不再吸收 trivia
  const a2 = pf.scanPatch(edited.text).entries.find((e) => e.id === 'mcp-a')
  assert.equal(edited.text.split('\n').slice(a2.start, a2.end).some((l) => l.includes('#')), false)
})

test('assertSafePatch：结构不对就返回 ok:false（写盘方据此回滚）', () => {
  assert.deepEqual(pf.assertSafePatch(SAMPLE, 'mcp-comfy'), { ok: true })
  assert.equal(pf.assertSafePatch(SAMPLE, 'mcp-nope').ok, false)
  // 组定向块里的条目不算"落在独立 insert 块内"
  const grouped = [
    '- id: my-group',
    "  name: '@deepseek-ai/dsh-whatever'",
    '  insert:',
    '    - id: mcp-gchild',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: gchild',
    '        transport: stdio',
    '        command: node',
    '',
  ].join('\n')
  const verdict = pf.assertSafePatch(grouped, 'mcp-gchild')
  assert.equal(verdict.ok, false)
  assert.match(verdict.problem, /找不到条目|不在任何独立/)
  // 删除这条组定向里的条目时，绝不能把别的插件的整段顶层项删掉
  const removed = pf.removeEntry(grouped, 'mcp-gchild')
  assert.equal(removed.removed, false, '组定向块里的条目不在管理范围，不应被删除')
  assert.equal(removed.text, grouped)
})
