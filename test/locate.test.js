'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { locateProfileDir, topLevelPatchIds } = require('../src/locate.js')

/** 内存文件系统桩：files 是 绝对路径 → 内容。 */
function makeIo(files) {
  const dirs = new Set()
  for (const p of Object.keys(files)) {
    let d = path.dirname(p)
    while (d && d !== path.dirname(d)) {
      dirs.add(d)
      d = path.dirname(d)
    }
  }
  return {
    isDir: (p) => dirs.has(p),
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p),
    readText: (p) => files[p],
    listDirs: (p) => [...dirs].filter((d) => path.dirname(d) === p).map((d) => path.basename(d)),
  }
}

test('桌面端场景：profile 目录来自 argv 位置参数（不是 --profile）', () => {
  const profile = 'C:\\Users\\u\\.dsh\\profiles\\desktop'
  const io = makeIo({
    [`${profile}\\cordis.patch.yml`]: '- id: a\n',
    [`${profile}\\cordis.yml`]: 'x: 1\n',
  })
  const argv = [
    'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    '--expose-internals',
    'C:\\App\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
    'C:\\App\\resources\\app.asar\\dsh',
    profile,
    'C:\\App\\resources\\runtime\\primary-runtime',
  ]
  const res = locateProfileDir({ argv, env: { DSH_HOME: 'C:\\Users\\u\\.dsh' }, io })
  assert.equal(res.dir, profile)
  assert.equal(res.source, 'argv')
})

test('环境变量 DSH_MCP_MANAGER_PROFILE 优先于一切', () => {
  const forced = 'D:\\forced-profile'
  const io = makeIo({ [`${forced}\\cordis.patch.yml`]: '- id: forced\n' })
  const res = locateProfileDir({ argv: [], env: { DSH_MCP_MANAGER_PROFILE: forced }, io })
  assert.equal(res.dir, forced)
  assert.equal(res.source, 'env:DSH_MCP_MANAGER_PROFILE')
})

test('argv 指错时用 live patch id 指纹兜底', () => {
  const home = 'C:\\Users\\u\\.dsh'
  const desktop = `${home}\\profiles\\desktop`
  const web = `${home}\\profiles\\web`
  const io = makeIo({
    [`${desktop}\\cordis.patch.yml`]: '- id: ui-theme\n- id: mcp-comfy\n',
    [`${web}\\cordis.patch.yml`]: '- id: other-plugin\n',
  })
  const res = locateProfileDir({
    argv: ['C:\\App\\node.exe', 'C:\\App\\runtime'],
    env: { DSH_HOME: home },
    io,
    livePatchIds: ['other-plugin', 'something-else'],
  })
  assert.equal(res.dir, web)
  assert.equal(res.source, 'fingerprint')
})

test('什么都定位不到时回退到 DSH_HOME 下存在的 profile', () => {
  const home = 'C:\\Users\\u\\.dsh'
  const desktop = `${home}\\profiles\\desktop`
  const io = makeIo({ [`${desktop}\\cordis.patch.yml`]: '- id: a\n' })
  const res = locateProfileDir({ argv: [], env: { DSH_HOME: home }, io })
  assert.equal(res.dir, desktop)
  assert.equal(res.source, 'fallback')
  assert.equal(res.candidates.length, 1)
})

test('完全找不到 profile 时返回 null 并给出候选', () => {
  const io = makeIo({})
  const res = locateProfileDir({ argv: [], env: { DSH_HOME: 'C:\\nope' }, io })
  assert.equal(res.dir, null)
  assert.equal(res.source, 'none')
})

test('topLevelPatchIds：抓顶层与 insert 内的 id', () => {
  const ids = topLevelPatchIds([
    '# c',
    '- id: ui-theme',
    '- insert:',
    "    - id: mcp-comfy",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    "        serverName: 'quoted-id'",
  ].join('\n'))
  assert.deepEqual([...ids].sort(), ['mcp-comfy', 'ui-theme'])
})
