'use strict'

/**
 * 会话模式（agent preset 组合）的存储层测试。
 *
 * 关注点：
 *   · 新增的声明必须包在 `- insert:` 块里 —— profile patch 顶层的 `- id:` 是
 *     「覆盖已有 entry」语义，直接写顶层会被 DSH 报 `entry "..." not found`。
 *   · plugins 必须是**完整组合**（基础模式 22 行 + MCP 行），因为 preset 不继承 Host 工具。
 *   · `!!js` 表达式与 group/isolate 结构必须逐字节保留（不能被 dumpYaml 重排）。
 *   · 幂等、并存、独立删除、删干净回到 `[]`。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const pf = require('../src/preset-file.js')
const ps = require('../src/preset-spec.js')

// 10 列起始的插件行块（模拟从 standard.patch.yml 切出来的样子）
const BASE_LINES = [
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  '            config:',
  '              prefix: You are a coding agent.',
  '          - id: tool-bash',
  "            name: '@deepseek-ai/dsh-tool-bash'",
  "            disabled: !!js process.platform === 'win32'",
  '          - id: planning',
  '            name: cordis:group',
  '            group: true',
  '            isolate:',
  '              planMode: true',
]

function spec(id, extra = {}) {
  return {
    rowId: `mcp-manager-preset-${id}`,
    presetId: id,
    name: `标准 + ${id}`,
    order: 50,
    pluginLines: pf.composePluginsLines(
      BASE_LINES,
      10,
      [{ id: `mcp-${id}`, config: { serverName: id, transport: 'stdio', command: 'C:/n/node.exe' } }],
      10,
    ),
    sourceItemIndent: 10,
    ...extra,
  }
}

test('新增组合：包在 - insert: 块里，且能读回元数据', () => {
  const out = pf.upsertPresetRow('# patch\n', spec('a'))
  assert.equal(out.action, 'appended')
  assert.match(out.text, /^- insert:$/m, '必须用 insert 块（顶层 - id: 是覆盖语义）')
  const rows = pf.listPresetRows(out.text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].rowId, 'mcp-manager-preset-a')
  assert.equal(rows[0].presetId, 'a')
  assert.equal(rows[0].name, '标准 + a')
})

test('新增组合：plugins 是完整组合（基础行 + MCP 行），不是只有 MCP', () => {
  const out = pf.upsertPresetRow('# patch\n', spec('a'))
  // 基础 3 个 id + MCP 1 个
  assert.equal(pf.listPresetRows(out.text)[0].pluginCount, 4)
  assert.match(out.text, /- id: persona/)
  assert.match(out.text, /- id: mcp-a/)
})

test('新增组合：!!js 表达式与 group/isolate 结构原样保留', () => {
  const out = pf.upsertPresetRow('# patch\n', spec('a'))
  assert.match(out.text, /disabled: !!js process\.platform === 'win32'/)
  assert.match(out.text, /name: cordis:group/)
  assert.match(out.text, /isolate:\s*\n\s+planMode: true/)
})

test('新增组合：缩进层级正确（insert 0 / 条目 4 / config 6 / plugins 8 / 元素 10）', () => {
  const out = pf.upsertPresetRow('# patch\n', spec('a'))
  const lines = out.text.split('\n')
  const idx = (re) => lines.findIndex((l) => re.test(l))
  assert.equal(lines[idx(/^- insert:$/)], '- insert:')
  assert.match(lines[idx(/^\s+- id: mcp-manager-preset-a$/)], /^ {4}- id:/)
  assert.match(lines[idx(/^\s+config:$/)], /^ {6}config:$/)
  assert.match(lines[idx(/^\s+plugins:$/)], /^ {8}plugins:$/)
  assert.match(lines[idx(/^\s+- id: persona$/)], /^ {10}- id:/)
})

test('重复保存同一组合是幂等的（不会每次都多出空行）', () => {
  const once = pf.upsertPresetRow('[]\n', spec('a')).text
  const twice = pf.upsertPresetRow(once, spec('a')).text
  const thrice = pf.upsertPresetRow(twice, spec('a')).text
  assert.equal(twice, once)
  assert.equal(thrice, twice)
  assert.equal(pf.listPresetRows(thrice).length, 1, '不应累积重复条目')
})

test('多个组合并存，互不影响', () => {
  let text = '# patch\n'
  text = pf.upsertPresetRow(text, spec('a')).text
  text = pf.upsertPresetRow(text, spec('b')).text
  const rows = pf.listPresetRows(text)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.presetId), ['a', 'b'])
  assert.equal(pf.listPresetRows(text)[0].pluginCount, 4)
  assert.equal(pf.listPresetRows(text)[1].pluginCount, 4)
})

test('删除其中一个组合，另一个完整保留（历史 bug：会切断后一个）', () => {
  let text = '# patch\n'
  text = pf.upsertPresetRow(text, spec('a')).text
  text = pf.upsertPresetRow(text, spec('b')).text
  const out = pf.removePresetRow(text, 'mcp-manager-preset-a')
  assert.equal(out.removed, true)
  const rows = pf.listPresetRows(out.text)
  assert.equal(rows.length, 1, '应只剩一个组合')
  assert.equal(rows[0].presetId, 'b')
  assert.equal(rows[0].pluginCount, 4, '剩下的组合不能被切断')
  assert.match(out.text, /- id: mcp-b/, 'MCP 行必须还在')
  assert.doesNotMatch(out.text, /serverName: a\b/)
})

test('删掉全部组合后文件回到合法的空数组', () => {
  let text = '# patch\n'
  text = pf.upsertPresetRow(text, spec('a')).text
  text = pf.removePresetRow(text, 'mcp-manager-preset-a').text
  assert.match(text, /^\[\]$/m)
  assert.equal(pf.listPresetRows(text).length, 0)
})

test('更新组合：改成另一组服务器后内容真的变了，且不残留旧行', () => {
  const once = pf.upsertPresetRow('# patch\n', spec('a')).text
  const two = pf.upsertPresetRow(once, {
    ...spec('a'),
    pluginLines: pf.composePluginsLines(BASE_LINES, 10, [{ id: 'mcp-x', config: { serverName: 'x' } }], 10),
  }).text
  assert.doesNotMatch(two, /serverName: a\b/)
  assert.match(two, /serverName: x/)
  assert.equal(pf.listPresetRows(two).length, 1)
})

test('自检：写坏的结构会被 assertSafePresetPatch 挡住', () => {
  // 缺 plugins
  const broken = ['- insert:', '    - id: mcp-manager-preset-bad', "      name: '@deepseek-ai/dsh-agent-preset'", '      config:', '        id: bad', ''].join('\n')
  assert.throws(() => pf.assertSafePresetPatch(broken, 'mcp-manager-preset-bad'), /plugins/)
  // 空 plugins
  const empty = ['- insert:', '    - id: mcp-manager-preset-bad', "      name: '@deepseek-ai/dsh-agent-preset'", '      config:', '        id: bad', '        plugins: []', ''].join('\n')
  assert.throws(() => pf.assertSafePresetPatch(empty, 'mcp-manager-preset-bad'), /plugins/)
})

test('自检：正常生成的组合能通过', () => {
  const out = pf.upsertPresetRow('# patch\n', spec('a'))
  assert.doesNotThrow(() => pf.assertSafePresetPatch(out.text, 'mcp-manager-preset-a'))
})

test('不会把用户在文件里的注释与其它条目弄丢', () => {
  const original = '# 我的注释\n\n- insert:\n    - id: mcp-keep\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n        serverName: keep\n'
  const out = pf.upsertPresetRow(original, spec('a'))
  assert.match(out.text, /# 我的注释/)
  assert.match(out.text, /- id: mcp-keep/)
  assert.match(out.text, /serverName: keep/)
})

test('extractPluginsBlock：能从 bundle 定义里切出 plugins 块', () => {
  const sample = [
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '          - id: tool-fs',
    "            name: '@deepseek-ai/dsh-tool-fs'",
    '- id: other-entry',
    '  config:',
    '    x: 1',
  ].join('\n')
  const block = ps.extractPluginsBlock(sample, 'preset-standard')
  assert.ok(block)
  assert.equal(block.lines.length, 4)
  assert.equal(block.itemIndent, 10)
  assert.match(block.lines[0], /- id: persona/)
})

test('extractPluginsBlock：找不到时返回 null 而不是抛错', () => {
  assert.equal(ps.extractPluginsBlock('[]\n', 'preset-nope'), null)
})

test('reindentLines：只改缩进，内容逐字节保留', () => {
  const input = ['  - id: a', "    disabled: !!js x === 'y'", '', '    name: b']
  const out = ps.reindentLines(input, 2, 10)
  assert.equal(out[0], '          - id: a')
  assert.equal(out[1], "            disabled: !!js x === 'y'")
  assert.equal(out[2], '')
  assert.equal(out[3], '            name: b')
})
