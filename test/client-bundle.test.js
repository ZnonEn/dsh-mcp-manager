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

/* ---- 主题配色回归：暗色主题下 brand-primary 是近白色 ----------------------
 * 历史 bug：`.mm-btn-primary` 写死 `color:#fff` 配 `background:brand-primary`，
 * 而暗色主题的 brand-primary 解析成近白色（官方主题表 neutral-bluish-50），
 * 于是按钮变成一块白板、文字不可见；hover 时底色又被通用 `.mm-btn:hover`
 * 盖成 bg-layer-2，才「碰巧」看得见 —— 正是用户看到的现象。三条用例盯着它。 */

function bundleCss() {
  const state = loadBundle()
  const mod = state.loaded.factory(fakeRequire)
  mod.apply({ effect(fn) { return fn() }, get() { return undefined } })
  return state.styles[0].textContent
}

test('主按钮前景色走 label-primary-inverted，样式表里不写死前景色', () => {
  const css = bundleCss()
  const primary = /\.mm-btn-primary\s*\{([^}]*)\}/.exec(css)
  assert.ok(primary, '应当有 .mm-btn-primary 规则')
  assert.match(primary[1], /color:var\(--dsw-alias-label-primary-inverted/)
  // 任何 color: 声明都不许是硬编码颜色：硬编码浅色在暗色主题下会隐形
  assert.deepEqual([...css.matchAll(/(?:^|[;{\s])color:\s*(?:#|rgba?\()/gi)].map((m) => m[0]), [])
})

test('主按钮 hover 排在通用 hover 之后，底色不会被 .mm-btn:hover 抢走', () => {
  const css = bundleCss()
  const generic = css.indexOf('.mm-btn:hover:not(:disabled)')
  const primary = css.indexOf('.mm-btn-primary:hover:not(:disabled)')
  assert.ok(generic >= 0, '应当有通用 hover 规则')
  assert.ok(primary >= 0, '应当有主按钮 hover 规则')
  assert.ok(primary > generic, '同级特异性靠书写顺序取胜，主按钮 hover 必须在后面')
  assert.match(css.slice(primary), /background:var\(--dsw-alias-button-primary-hover/)
})

test('承载文字的 surface 兜底色不是不透明浅色', () => {
  const css = bundleCss()
  const hardcoded = [...css.matchAll(/background:[^;}]*#(?:fff|ffffff|fafafa|f5f5f5)\b/gi)].map((m) => m[0])
  assert.deepEqual(hardcoded, [], 'token 缺失时会退化成白底白字，兜底必须是主题中性的')
})
