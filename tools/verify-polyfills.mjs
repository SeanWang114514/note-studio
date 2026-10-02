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

console.log('\n全部断言通过 ✅')
