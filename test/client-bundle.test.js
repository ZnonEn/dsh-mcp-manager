'use strict'

/**
 * 客户端 bundle 无法在没有 DSH 页面的情况下端到端渲染，这里用 vm 沙箱把
 * bundle 跑一遍，验证它对 client-modules 协议与设置页 slot 的契约：
 *   · window.__ModuleLoader__.load({ id, factory }) 的形状
 *   · 导出 inject = ['slots'] 与 apply(ctx)
 *   · apply 会往 settings.section 注册 id/label/order 正确的页面
 *   · 注入的 <style> 带 data-plugin 标记（卸载时可清理）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const BUNDLE = path.join(__dirname, '..', 'client', 'bundle.js')

function loadBundle() {
  const code = fs.readFileSync(BUNDLE, 'utf8')
  const state = { loaded: null, styles: [], removed: [] }
  const fakeDocument = {
    createElement(tag) {
      const el = {
        tagName: tag,
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(k, v) { this.attributes[k] = v },
      }
      state.styles.push(el)
      return el
    },
    head: {
      append(el) { el.parentNode = { removeChild: () => state.removed.push(el) } },
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { state.loaded = definition } } },
    document: fakeDocument,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client/bundle.js' })
  return state
}

function fakeRequire(name) {
  if (name === 'react') {
    return {
      createElement(type, props) {
        const children = Array.prototype.slice.call(arguments, 2)
        return { type, props: props || {}, children }
      },
      useState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
      useEffect() {},
    }
  }
  throw new Error(`bundle 不该 require(${JSON.stringify(name)})`)
}

test('bundle 遵循 client-modules 协议并按 id 注册', () => {
  const state = loadBundle()
  assert.ok(state.loaded, 'bundle 应当调用 window.__ModuleLoader__.load')
  assert.equal(state.loaded.id, 'dsh-mcp-manager')
  assert.equal(typeof state.loaded.factory, 'function')
})

test('bundle 导出 inject=[slots] 与 apply', () => {
  const state = loadBundle()
  const mod = state.loaded.factory(fakeRequire)
  assert.deepEqual([...mod.inject], ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply 把设置页注册进 settings.section', () => {
  const state = loadBundle()
  const mod = state.loaded.factory(fakeRequire)

  const registered = []
  const slots = {
    inject(slotName, callback) {
      assert.equal(slotName, 'settings.section')
      return callback()
    },
    register(registration, component) {
      registered.push({ registration, component })
    },
  }
  const ctx = {
    effect(fn) { return fn() },
    get(name) { return name === 'slots' ? slots : undefined },
  }

  mod.apply(ctx)

  assert.equal(registered.length, 1, '应当注册恰好一个设置页')
  const { registration, component } = registered[0]
  assert.equal(registration.name, 'settings.section')
  assert.equal(registration.id, 'mcp-manager')
  assert.equal(registration.label, 'MCP 服务器')
  assert.equal(typeof registration.order, 'number')
  assert.equal(typeof component, 'function')
})

test('apply 注入带 data-plugin 标记的样式表，且卸载时可移除', () => {
  const state = loadBundle()
  const mod = state.loaded.factory(fakeRequire)
  const disposers = []
  const ctx = {
    effect(fn) { disposers.push(fn()) },
    get() { return undefined }, // 没有 slots 服务时不应抛错
  }
  mod.apply(ctx)
  assert.equal(state.styles.length, 1)
  assert.equal(state.styles[0].tagName, 'style')
  assert.equal(state.styles[0].attributes['data-plugin'], 'dsh-mcp-manager')
  assert.match(state.styles[0].textContent, /\.mm-root/)
  // 卸载：样式被移除
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.deepEqual(state.removed, [state.styles[0]])
})

test('bundle 不依赖 Node/构建产物之外的模块', () => {
  const code = fs.readFileSync(BUNDLE, 'utf8')
  const required = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(required)], ['react'])
})
