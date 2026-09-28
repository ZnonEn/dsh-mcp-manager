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
  // 原有内容一字不动：把新增部分去掉后应当还原成原文
  const removed = pf.removeEntry(added.text, 'mcp-selftest-not-written')
  assert.equal(pf.listMcpEntries(removed.text).length, beforeEntryCount)
  assert.match(removed.text, /mcp-comfy/)
  assert.match(removed.text, /# Your patch layer for this dsh profile/)
})

test('真实 profile：locateProfileDir 用真实 argv 运行时能定到 desktop profile', { skip: !exists && '未找到真实的 cordis.patch.yml' }, () => {
  const res = locateProfileDir({ env: { DSH_HOME: HOME } })
  assert.equal(res.dir, path.join(HOME, 'profiles', 'desktop'))
})
