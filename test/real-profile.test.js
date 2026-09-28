'use strict'

/**
 * 真实数据只读验证：直接拿本机 DSH 桌面端 profile 的 cordis.patch.yml 跑解析。
 * 只读，不写任何东西；文件不存在时跳过（例如换机器/换 profile）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pf = require('../src/patch-file.js')
const { locateProfileDir } = require('../src/locate.js')

const HOME = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh')
const REAL_PATCH = path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')
const exists = fs.existsSync(REAL_PATCH)

test('真实 profile：能读出 mcp-comfy 条目且字段与文件一致', { skip: !exists && '未找到真实的 cordis.patch.yml' }, () => {
  const text = fs.readFileSync(REAL_PATCH, 'utf8')
  const entries = pf.listMcpEntries(text)
  assert.equal(entries.length >= 1, true, '至少应有一个 MCP 条目')
  const comfy = entries.find((e) => e.id === 'mcp-comfy')
  assert.ok(comfy, '应能读出 mcp-comfy 条目')
  assert.equal(comfy.moduleName, '@deepseek-ai/dsh-mcp-client')
  assert.equal(comfy.parseError, null)
  assert.equal(comfy.config.serverName, 'comfy')
  assert.equal(comfy.config.transport, 'stdio')
  assert.match(comfy.config.command, /comfy-mcp\.exe$/)
  assert.match(comfy.config.env.COMFY_BIN, /comfy\.exe$/)
  assert.equal(comfy.config.toolCallTimeoutMs, 600000)
  assert.equal(comfy.config.failOnStartupError, true)
})

test('真实 profile：对文件做一次「编辑后删除」的写操作模拟，不落盘', { skip: !exists && '未找到真实的 cordis.patch.yml' }, () => {
  const text = fs.readFileSync(REAL_PATCH, 'utf8')
  const beforeEntryCount = pf.listMcpEntries(text).length
  const added = pf.upsertEntry(text, {
    id: 'mcp-selftest-not-written',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'selftest', transport: 'stdio', command: 'node' },
  })
  assert.equal(pf.listMcpEntries(added.text).length, beforeEntryCount + 1)
  // 原有内容一字不动：把新增部分去掉后应当**字节相等**地还原成原文
  const removed = pf.removeEntry(added.text, 'mcp-selftest-not-written')
  assert.equal(pf.listMcpEntries(removed.text).length, beforeEntryCount)
  assert.equal(removed.text, text, '新增再删除后应与原文字节相等')
  assert.match(removed.text, /mcp-comfy/)
})

test('真实 profile：编辑已有条目后仍是合法结构（内存模拟，不落盘）', { skip: !exists && '未找到真实的 cordis.patch.yml' }, () => {
  const text = fs.readFileSync(REAL_PATCH, 'utf8')
  const edited = pf.upsertEntry(text, {
    id: 'mcp-comfy',
    moduleName: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'comfy',
      transport: 'stdio',
      command: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe',
      args: ['--stdio'],
      env: { COMFY_BIN: 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy.exe' },
      toolCallTimeoutMs: 600000,
      failOnStartupError: true,
    },
  })
  assert.equal(pf.assertSafePatch(edited.text, 'mcp-comfy').ok, true)
  const entries = pf.listMcpEntries(edited.text)
  assert.deepEqual(entries.map((e) => e.id), ['mcp-comfy'])
  assert.deepEqual(entries[0].config.args, ['--stdio'])
  // 其它顶层项与注释仍在
  assert.match(edited.text, /# Your patch layer for this dsh profile/)
  assert.match(edited.text, /- id: ui-theme/)
})

test('真实 profile：locateProfileDir 在无 argv 时靠回退链定位', { skip: !exists && '未找到真实的 cordis.patch.yml' }, () => {
  const res = locateProfileDir({ argv: [], env: { DSH_HOME: HOME } })
  assert.equal(res.dir, path.join(HOME, 'profiles', 'desktop'))
})

test('真实 profile：locateProfileDir 从 argv 的位置参数定位（桌面端真实形状）', { skip: !exists && '未找到真实的 cordis.patch.yml' }, () => {
  const profileDir = path.join(HOME, 'profiles', 'desktop')
  const res = locateProfileDir({
    argv: [
      'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
      '--expose-internals',
      'C:\\App\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
      'C:\\App\\resources\\app.asar\\dsh',
      profileDir,
      'C:\\App\\resources\\runtime\\primary-runtime',
    ],
    env: { DSH_HOME: HOME },
  })
  assert.equal(res.dir, profileDir)
  assert.equal(res.source, 'argv')
})
