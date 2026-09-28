'use strict'

/**
 * 诊断工具：打印一个 cordis.patch.yml 里所有 insert 条目的解析结果。
 *
 * 用法：
 *   node tools/inspect-patch.js                      # 默认读桌面端 profile
 *   node tools/inspect-patch.js <某个 cordis.patch.yml>
 *
 * 只读，不修改任何文件。设置页里显示的数据不对时，先用它确认是文件解析问题
 * 还是运行状态问题。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pf = require('../src/patch-file.js')
const { locateProfileDir } = require('../src/locate.js')

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const located = locateProfileDir({})
const target = process.argv[2] || (located.file || path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'))

console.log('DSH_HOME      :', home)
console.log('定位到的 profile:', located.dir || '(未定位)', '｜来源：', located.source)
console.log('读取文件      :', target)
if (!fs.existsSync(target)) {
  console.error('文件不存在')
  process.exit(1)
}

const text = fs.readFileSync(target, 'utf8')
const scanned = pf.scanPatch(text)
console.log('总行数        :', text.split(/\r?\n/).length)
console.log('顶层 insert 块:', scanned.inserts.length)
console.log('insert 条目数 :', scanned.entries.length)
console.log('MCP 条目数    :', pf.listMcpEntries(text).length)
console.log('')

for (const entry of scanned.entries) {
  console.log('-'.repeat(60))
  console.log(JSON.stringify({
    id: entry.id,
    moduleName: entry.moduleName,
    行范围: `${entry.start + 1}-${entry.end}`,
    itemIndent: entry.itemIndent,
    keyIndent: entry.keyIndent,
    parseError: entry.parseError,
    config: entry.config,
  }, null, 2))
}
