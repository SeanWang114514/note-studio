// 验证 src/lib/polyfills.js：先删掉目标 API（模拟旧版 WebView / Chrome < 119），
// 再加载补丁，逐项断言行为。运行：node tmp/verify-polyfills.mjs
import assert from 'node:assert/strict'

const targets = {
  'Promise.withResolvers': () => delete Promise.withResolvers,
  'Promise.any': () => delete Promise.any,
  'Promise.allSettled': () => delete Promise.allSettled,
  'Promise.try': () => delete Promise.try,
  'Array.prototype.at': () => delete Array.prototype.at,
  'String.prototype.at': () => delete String.prototype.at,
  'Array.prototype.findLast': () => delete Array.prototype.findLast,
  'Array.prototype.findLastIndex': () => delete Array.prototype.findLastIndex,
  'Array.prototype.toReversed': () => delete Array.prototype.toReversed,
  'Array.prototype.toSorted': () => delete Array.prototype.toSorted,
  'Array.prototype.toSpliced': () => delete Array.prototype.toSpliced,
  'Array.prototype.with': () => delete Array.prototype.with,
  'String.prototype.replaceAll': () => delete String.prototype.replaceAll,
  'Object.hasOwn': () => delete Object.hasOwn,
  'Object.fromEntries': () => delete Object.fromEntries,
  'Object.groupBy': () => delete Object.groupBy,
  'Map.groupBy': () => delete Map.groupBy,
  'Set.prototype.union': () => delete Set.prototype.union,
  'Set.prototype.intersection': () => delete Set.prototype.intersection,
  'Set.prototype.difference': () => delete Set.prototype.difference,
  'Set.prototype.symmetricDifference': () => delete Set.prototype.symmetricDifference,
  'Set.prototype.isSubsetOf': () => delete Set.prototype.isSubsetOf,
  'Set.prototype.isSupersetOf': () => delete Set.prototype.isSupersetOf,
  'Set.prototype.isDisjointFrom': () => delete Set.prototype.isDisjointFrom,
  'URL.canParse': () => delete URL.canParse,
  'AbortSignal.timeout': () => delete AbortSignal.timeout,
  structuredClone: () => delete globalThis.structuredClone,
}

for (const [name, del] of Object.entries(targets)) del()
console.log(`已删除 ${Object.keys(targets).length} 个 API，模拟旧 WebView`)

// 确认真的删掉了（否则测试无意义）
for (const name of ['Promise.withResolvers', 'structuredClone']) {
  const ok = name === 'structuredClone' ? typeof globalThis.structuredClone : typeof Promise.withResolvers
  assert.equal(ok, 'undefined', `${name} 应已被删除`)
}

await import('../src/lib/polyfills.js')
console.log('已加载 polyfills.js\n')

// ── 补丁是否就位 ────────────────────────────────────────────────────────
const present = {
  'Promise.withResolvers': typeof Promise.withResolvers,
  'Promise.any': typeof Promise.any,
  'Promise.allSettled': typeof Promise.allSettled,
  'Promise.try': typeof Promise.try,
  'Array.prototype.at': typeof [].at,
  'String.prototype.at': typeof ''.at,
  'Array.prototype.findLast': typeof [].findLast,
  'Array.prototype.toSpliced': typeof [].toSpliced,
  'String.prototype.replaceAll': typeof ''.replaceAll,
  'Object.hasOwn': typeof Object.hasOwn,
  'Object.groupBy': typeof Object.groupBy,
  'Map.groupBy': typeof Map.groupBy,
  'Set.prototype.union': typeof Set.prototype.union,
  'URL.canParse': typeof URL.canParse,
  'AbortSignal.timeout': typeof AbortSignal.timeout,
  structuredClone: typeof globalThis.structuredClone,
}
for (const [name, type] of Object.entries(present)) {
  assert.equal(type, 'function', `${name} 未被补上`)
}
console.log('✓ 全部 API 已补齐')

// ── 行为断言 ───────────────────────────────────────────────────────────
// 1) 本次故障的根因 API
const { promise, resolve, reject } = Promise.withResolvers()
assert.equal(typeof promise.then, 'function')
resolve(42)
assert.equal(await promise, 42)
const r2 = Promise.withResolvers()
r2.reject(new Error('boom'))
await assert.rejects(r2.promise, /boom/)
const r3 = Promise.withResolvers()
assert.deepEqual(Object.keys(r3).sort(), ['promise', 'reject', 'resolve'])
console.log('✓ Promise.withResolvers')

// 2) Promise.any / allSettled / try
assert.equal(await Promise.any([Promise.reject(new Error('a')), Promise.resolve('b')]), 'b')
await assert.rejects(Promise.any([Promise.reject(new Error('x')), Promise.reject(new Error('y'))]), (err) => {
  assert.equal(err.name, 'AggregateError')
  assert.equal(err.errors.length, 2)
  return true
})
assert.deepEqual(await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error('e'))]), [
  { status: 'fulfilled', value: 1 },
  { status: 'rejected', reason: new Error('e') },
])
assert.equal(await Promise.try((a, b) => a + b, 2, 3), 5)
await assert.rejects(Promise.try(() => { throw new Error('sync') }), /sync/)
console.log('✓ Promise.any / allSettled / try')

// 3) at / findLast / toSpliced / toSorted / toReversed / with
assert.equal([1, 2, 3].at(-1), 3)
assert.equal([1, 2, 3].at(5), undefined)
assert.equal('abc'.at(-1), 'c')
assert.equal([1, 2, 3, 4].findLast((n) => n % 2 === 0), 4)
assert.equal([1, 2, 3, 4].findLastIndex((n) => n % 2 === 1), 2)
const src = [1, 2, 3, 4]
assert.deepEqual(src.toSpliced(1, 2, 99), [1, 99, 4], 'toSpliced 必须返回修改后的副本')
assert.deepEqual(src, [1, 2, 3, 4], 'toSpliced 不得改动原数组')
assert.deepEqual([3, 1, 2].toSorted(), [1, 2, 3])
assert.deepEqual([1, 2, 3].toReversed(), [3, 2, 1])
assert.deepEqual([1, 2, 3].with(-1, 9), [1, 2, 9])
assert.throws(() => [1, 2, 3].with(9, 0), RangeError)
console.log('✓ at / findLast / toSpliced / toSorted / toReversed / with')

// 4) replaceAll（替换串里的 $ 模式按原生语义解释，已用原生实现核对过）
assert.equal('a-b-c'.replaceAll('-', '+'), 'a+b+c')
assert.equal('a.b'.replaceAll('.', '$&'), 'a.b', '$& 应解释为匹配到的子串')
assert.equal('a-b'.replaceAll('-', '$$'), 'a$b', '$$ 应解释为字面 $')
assert.equal('aaa'.replaceAll('a', (m) => m.toUpperCase()), 'AAA')
assert.equal('x'.replaceAll('', '-'), '-x-', '空 needle 应插到每个字符前后')
assert.equal('a.b'.replaceAll('.', 'X'), 'aXb')
console.log('✓ String.replaceAll')

// 5) hasOwn / fromEntries / groupBy
assert.equal(Object.hasOwn({ a: 1 }, 'a'), true)
assert.equal(Object.hasOwn({}, 'toString'), false)
assert.deepEqual(Object.fromEntries([['a', 1]]), { a: 1 })
assert.deepEqual(Object.groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even')), {
  odd: [1, 3],
  even: [2, 4],
})
const grouped = Map.groupBy([1, 2, 3], (n) => (n % 2 ? 'odd' : 'even'))
assert.equal(grouped instanceof Map, true)
assert.deepEqual(grouped.get('odd'), [1, 3])
console.log('✓ Object.hasOwn / fromEntries / groupBy')

// 6) Set 集合运算
const A = new Set([1, 2, 3])
const B = new Set([3, 4])
assert.deepEqual([...A.union(B)].sort(), [1, 2, 3, 4])
assert.deepEqual([...A.intersection(B)], [3])
assert.deepEqual([...A.difference(B)].sort(), [1, 2])
assert.deepEqual([...A.symmetricDifference(B)].sort(), [1, 2, 4])
assert.equal(new Set([1]).isSubsetOf(A), true)
assert.equal(A.isSupersetOf(new Set([1, 2])), true)
assert.equal(new Set([9]).isDisjointFrom(A), true)
console.log('✓ Set 集合运算')

// 7) URL.canParse / AbortSignal.timeout
assert.equal(URL.canParse('https://example.com/x'), true)
assert.equal(URL.canParse('not a url'), false)
const signal = AbortSignal.timeout(10)
await new Promise((r) => setTimeout(r, 40))
assert.equal(signal.aborted, true)
assert.equal(signal.reason?.name, 'TimeoutError')
console.log('✓ URL.canParse / AbortSignal.timeout')

// 8) structuredClone（含 Map/Set/Date/TypedArray/循环引用）
const date = new Date('2024-01-02T03:04:05Z')
const map = new Map([['k', { deep: true }]])
const set = new Set([1, 2])
const typed = new Uint8Array([1, 2, 3])
const cyc = { name: 'root' }
cyc.self = cyc
const original = { date, map, set, typed, list: [1, [2]], cyc, fn: undefined }
const cloned = structuredClone(original)
assert.notEqual(cloned.date, date)
assert.equal(cloned.date.getTime(), date.getTime())
assert.notEqual(cloned.map, map)
assert.equal(cloned.map.get('k').deep, true)
assert.equal(cloned.map.get('k') !== map.get('k'), true)
assert.deepEqual([...cloned.set], [1, 2])
assert.equal(cloned.typed instanceof Uint8Array, true)
assert.deepEqual([...cloned.typed], [1, 2, 3])
assert.equal(cloned.cyc.self, cloned.cyc, '循环引用应保持结构且不死循环')
assert.deepEqual(cloned.list, [1, [2]])
console.log('✓ structuredClone（含循环引用 / Map / Set / 定型数组）')

// ── 9) 注入进 worker 产物的拼接安全性（v0.1.17 真凶的回归护栏）────────────
// 背景：polyfills.js 会被 vite.config.js 原样前置进压缩后的 pdf.worker 产物。
// 它结尾曾是 `})()`，而压缩产物开头是 `(function(){...`；JS 的 ASI 不会在 `(`
// 前补分号，两段于是粘成 `})(...)(function(){...})` —— 是**合法语法**，所以
// 光看语法检查发现不了；实际运行时 worker 一加载就抛
// 「(intermediate value)(...) is not a function」，只打一行 console.error，
// pdf.js 永远等不到 ready，页面就卡在「正在打开 PDF…」。
// 这里真正把「拼起来的代码」跑一遍，断言 polyfills 的执行结果没被污染。
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const polyfillSrc = readFileSync(
  fileURLToPath(new URL('../src/lib/polyfills.js', import.meta.url)),
  'utf8',
)

// 模拟 real worker 产物的开头（压缩后以 `(function(){` 起头）
const fakeWorkerTail = '(function(){"use strict";globalThis.__workerBooted=true})();'
const glued = `${polyfillSrc}\n;\n${fakeWorkerTail}`

// eslint-disable-next-line no-new-func
new Function(glued)()
assert.equal(globalThis.__workerBooted, true, 'worker 产物必须真的执行到（拼接后不能变成一次函数调用）')
console.log('✓ 注入 worker 的拼接不会触发 ASI 陷阱')

// 源码自身也应以 `;` 收尾（第二道保险）。
// 注意要剥掉尾部注释再判断 —— 文件末尾有说明性注释，`trimEnd()` 看到的是注释不是代码。
const polyfillCodeTail = polyfillSrc.replace(/\/\/[^\n]*$/gm, '').trimEnd()
assert.match(polyfillCodeTail, /;\s*$/, 'polyfills.js 的代码应以分号结尾，避免被前置拼接时粘连')
console.log('✓ polyfills.js 以分号收尾')

// vite.config.js 的注入必须显式补 `;`
const viteSrc = readFileSync(fileURLToPath(new URL('../vite.config.js', import.meta.url)), 'utf8')
assert.match(
  viteSrc,
  /const injected = `\$\{source\}\\n;\\n`/,
  'vite.config.js 注入 worker 时必须写成 `${source}\\n;\\n`（缺分号会让 worker 静默死掉）',
)
console.log('✓ vite.config.js 注入worker 时补了分号')

console.log('\n全部断言通过 ✅')
