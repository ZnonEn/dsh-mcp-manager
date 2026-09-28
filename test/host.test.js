'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const plugin = require('../src/index.js')

const SAMPLE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: dark',
  '- id: web-ui-market',
  '  disabled: true',
  '# dsh-plugin-capabilities 的 profile 解析注意事项（用户写的注释）',
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

/** 用真实的临时目录 + 临时 profile 环境变量跑一遍 host 半边。 */
function setup(services, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-manager-test-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, SAMPLE, 'utf8')
  const previous = process.env.DSH_MCP_MANAGER_PROFILE
  process.env.DSH_MCP_MANAGER_PROFILE = dir

  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(fn) { return fn() },
    get(name) { return services ? services[name] : undefined },
    logger: { info() {}, warn() {}, error() {} },
  }
  plugin.apply(ctx, config || {})

  return {
    dir,
    file,
    routes,
    read: () => fs.readFileSync(file, 'utf8'),
    cleanup() {
      if (previous === undefined) delete process.env.DSH_MCP_MANAGER_PROFILE
      else process.env.DSH_MCP_MANAGER_PROFILE = previous
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function invoke(routes, routePath, method, payload) {
  const handler = routes.get(routePath)
  assert.ok(handler, `路由未注册：${routePath}`)
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method || 'GET'
    const res = {
      statusCode: 0,
      headers: null,
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(data) {
        const text = data === undefined ? '' : String(data)
        try {
          resolve({ status: this.statusCode, json: text === '' ? null : JSON.parse(text) })
        } catch (e) {
          reject(new Error(`响应不是 JSON：${text.slice(0, 120)}`))
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload), 'utf8'))
    req.emit('end')
  })
}

test('注册了全部路由', () => {
  const env = setup()
  try {
    for (const p of ['/mcp-manager/state', '/mcp-manager/raw', '/mcp-manager/save', '/mcp-manager/remove', '/mcp-manager/toggle', '/mcp-manager/refresh']) {
      assert.ok(env.routes.has(p), `缺少路由 ${p}`)
    }
  } finally {
    env.cleanup()
  }
})

test('GET state：定位到临时 profile，并读出现有 MCP 服务器', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/state', 'GET')
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.profile.dir, env.dir)
    assert.equal(res.json.profile.source, 'env:DSH_MCP_MANAGER_PROFILE')
    assert.equal(res.json.profile.file, env.file)
    assert.equal(res.json.servers.length, 1)
    const server = res.json.servers[0]
    assert.equal(server.id, 'mcp-comfy')
    assert.equal(server.config.serverName, 'comfy')
    assert.equal(server.config.command, 'D:\\ComfyUI-aki-v3.2\\python\\Scripts\\comfy-mcp.exe')
    assert.equal(server.summary.transport, 'stdio')
    assert.deepEqual(server.summary.envKeys, ['COMFY_BIN'])
    assert.equal(server.sync, 'pending-restart') // 没有 pluginManager，当前进程里没有该条目
  } finally {
    env.cleanup()
  }
})

test('POST save：新增服务器只追加条目，其它内容与注释原样保留', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/save', 'POST', {
      server: {
        serverName: 'files',
        transport: 'stdio',
        command: 'npx',
        args: '-y\n@modelcontextprotocol/server-filesystem\nD:\\work',
        env: 'FOO=bar',
      },
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.ok, true)
    assert.equal(res.json.id, 'mcp-files')
    assert.equal(res.json.restartRequired, true)

    const text = env.read()
    assert.match(text, /- id: mcp-files/)
    assert.match(text, /# dsh-plugin-capabilities 的 profile 解析注意事项（用户写的注释）/)
    assert.match(text, /- id: ui-theme/)
    assert.match(text, /- id: mcp-comfy/)

    const state = await invoke(env.routes, '/mcp-manager/state', 'GET')
    assert.deepEqual(state.json.servers.map((s) => s.id).sort(), ['mcp-comfy', 'mcp-files'])
    const added = state.json.servers.find((s) => s.id === 'mcp-files')
    assert.deepEqual(added.config.args, ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\work'])
    assert.deepEqual(added.config.env, { FOO: 'bar' })
  } finally {
    env.cleanup()
  }
})

test('POST save：编辑已有条目（stdio → streamable-http）', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/save', 'POST', {
      originalId: 'mcp-comfy',
      server: {
        id: 'mcp-comfy',
        serverName: 'comfy',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:9100/mcp',
        headers: 'Authorization=Bearer t',
        toolCallTimeoutMs: '120000',
      },
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const state = await invoke(env.routes, '/mcp-manager/state', 'GET')
    const server = state.json.servers.find((s) => s.id === 'mcp-comfy')
    assert.equal(server.config.transport, 'streamable-http')
    assert.equal(server.config.url, 'http://127.0.0.1:9100/mcp')
    assert.equal(server.config.toolCallTimeoutMs, 120000)
    assert.equal(server.config.command, undefined)
    assert.equal(state.json.servers.length, 1)
  } finally {
    env.cleanup()
  }
})

test('POST save：重复的 serverName 与非法配置被拒绝（400，不写文件）', async () => {
  const env = setup()
  try {
    const dup = await invoke(env.routes, '/mcp-manager/save', 'POST', {
      server: { serverName: 'comfy', transport: 'stdio', command: 'node' },
    })
    assert.equal(dup.status, 400)
    assert.equal(dup.json.ok, false)
    assert.match(dup.json.details.join('|'), /已被另一个 MCP 服务器/)

    const bad = await invoke(env.routes, '/mcp-manager/save', 'POST', {
      server: { serverName: 'nope', transport: 'stdio' },
    })
    assert.equal(bad.status, 400)
    assert.match(bad.json.details.join('|'), /command/)

    assert.equal(env.read(), SAMPLE)
  } finally {
    env.cleanup()
  }
})

test('POST remove：删除条目并生成备份', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/remove', 'POST', { id: 'mcp-comfy' })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    // 没有 pluginManager 时无法确认是否已卸载 —— 不能宣称"已从运行中卸载"
    assert.equal(res.json.live, false)
    assert.equal(res.json.restartRequired, false)
    assert.match(res.json.note, /如果已经建立/)
    const text = env.read()
    assert.equal(/- id: mcp-comfy/.test(text), false)
    assert.equal(/- insert:/.test(text), false)
    assert.match(text, /- id: ui-theme/)
    const backups = fs.readdirSync(env.dir).filter((n) => n.includes('.bak-mcp-manager-'))
    assert.equal(backups.length >= 1, true, '应当生成备份文件')
    assert.equal(fs.readFileSync(path.join(env.dir, backups[0]), 'utf8'), SAMPLE)
  } finally {
    env.cleanup()
  }
})

test('POST remove：条目原本在运行中 → 确认卸载后如实报告', async () => {
  let env = null
  const services = {
    pluginManager: {
      // 模拟真实语义：条目还在文件里就还在运行树里，删掉就消失
      async listPlugins() {
        const stillThere = env !== null && /- id: mcp-comfy/.test(env.read())
        return stillThere
          ? [{ entryId: 'mcp-comfy', patchId: 'mcp-comfy', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active' }]
          : []
      },
      async setPluginEnabled() { return { application: 'applied' } },
    },
  }
  env = setup(services)
  try {
    const res = await invoke(env.routes, '/mcp-manager/remove', 'POST', { id: 'mcp-comfy' })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.live, true)
    assert.equal(res.json.restartRequired, false)
    assert.match(res.json.note, /已从运行中的 DSH 卸载/)
  } finally {
    env.cleanup()
  }
})

test('POST remove：条目不存在返回 404', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/remove', 'POST', { id: 'mcp-nope' })
    assert.equal(res.status, 404)
    assert.equal(res.json.ok, false)
  } finally {
    env.cleanup()
  }
})

test('POST toggle：没有 pluginManager 时写 disabled 键', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/toggle', 'POST', { id: 'mcp-comfy', enabled: false })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.restartRequired, true)
    // 停用状态写成「顶层 - id: X + disabled: true」覆盖项 —— 与 DSH 官方 writePluginEnabled 同款形式
    assert.match(env.read(), /^- id: mcp-comfy\n {2}disabled: true$/m)

    const state = await invoke(env.routes, '/mcp-manager/state', 'GET')
    assert.equal(state.json.servers[0].disabled, true)
    assert.equal(state.json.servers[0].disabledSource, 'top-level')
    assert.equal(state.json.servers[0].sync, 'disabled')

    const back = await invoke(env.routes, '/mcp-manager/toggle', 'POST', { id: 'mcp-comfy', enabled: true })
    assert.equal(back.status, 200)
    assert.equal(/- id: mcp-comfy\n {2}disabled: true/.test(env.read()), false)
    // 只剩 id + disabled 的覆盖项应当整项删除（insert 里的条目本身不能被误删）
    assert.equal(/^- id: mcp-comfy$/m.test(env.read()), false)
    assert.match(env.read(), /^ {4}- id: mcp-comfy$/m)
  } finally {
    env.cleanup()
  }
})

test('POST toggle：有 pluginManager 时热生效，并标记 live 状态', async () => {
  const calls = []
  const services = {
    pluginManager: {
      async listPlugins() {
        return [{
          entryId: 'mcp-comfy',
          patchId: 'mcp-comfy',
          moduleName: '@deepseek-ai/dsh-mcp-client',
          enabled: true,
          fiberPhase: 'active',
        }]
      },
      async setPluginEnabled(id, enabled) {
        calls.push([id, enabled])
        return { changed: true, application: 'applied', stage: 'enable', target: id }
      },
    },
  }
  const env = setup(services)
  try {
    const state = await invoke(env.routes, '/mcp-manager/state', 'GET')
    assert.equal(state.json.liveAvailable, true)
    assert.equal(state.json.servers[0].sync, 'live')
    const res = await invoke(env.routes, '/mcp-manager/toggle', 'POST', { id: 'mcp-comfy', enabled: false })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(calls, [['mcp-comfy', false]])
    assert.equal(res.json.applied, 'applied')
    assert.equal(res.json.restartRequired, false)
    // 即使热停用成功，也要自己把状态落盘：官方对 insert 内的条目不会持久化，
    // 否则重启后服务器会"复活"
    assert.match(env.read(), /^- id: mcp-comfy\n {2}disabled: true$/m)
  } finally {
    env.cleanup()
  }
})

test('GET raw：返回配置文件原文', async () => {
  const env = setup()
  try {
    const res = await invoke(env.routes, '/mcp-manager/raw', 'GET')
    assert.equal(res.status, 200)
    assert.equal(res.json.text, SAMPLE)
  } finally {
    env.cleanup()
  }
})

test('POST toggle：pluginManager 卡住时超时降级，不挂死请求', async () => {
  const services = {
    pluginManager: {
      async listPlugins() {
        return [{ entryId: 'mcp-comfy', patchId: 'mcp-comfy', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'loading' }]
      },
      // 官方实现会 await reload：条目卡在 MCP 握手时可能长时间不返回（实测 toggle 挂死过）
      setPluginEnabled() { return new Promise(() => {}) },
    },
  }
  const env = setup(services, { setPluginEnabledTimeoutMs: 300 })
  try {
    const started = Date.now()
    const res = await invoke(env.routes, '/mcp-manager/toggle', 'POST', { id: 'mcp-comfy', enabled: false })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.applied, 'pending')
    assert.equal(res.json.restartRequired, true)
    assert.match(res.json.note, /还在连接中/)
    assert.equal(Date.now() - started < 5000, true, '不应挂死')
    // 超时同样要把状态落盘（否则重启后服务器会复活）
    assert.match(env.read(), /^- id: mcp-comfy\n {2}disabled: true$/m)
  } finally {
    env.cleanup()
  }
})
