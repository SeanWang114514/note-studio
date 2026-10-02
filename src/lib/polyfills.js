/* polyfills.js — 旧版 WebView 兼容补丁
 *
 * 背景：pdfjs-dist 4.x 用了 Promise.withResolvers（ES2024，Chrome 119+ 才有）。
 * Android 系统 WebView 版本偏低的机器上打开 PDF 会直接抛
 *   TypeError: Promise.withResolvers is not a function
 * 表现为「PDF 打开失败」。Vite 的 build.target 只做语法降级（esbuild 不会
 * 自动补 API），所以这里手工补齐 pdfjs 及本应用可能用到的较新 API。
 *
 * ⚠️ 本文件以「纯语句」形式存在，既被 src/main.jsx 当副作用模块导入（主线程），
 *    也被 vite.config.js 的插件原样前置进 pdfjs 的 worker 产物（worker 是独立
 *    线程，主线程的补丁到不了它，而 pdfjs 的 worker 里同样调用了这些 API）。
 *    因此：不要写 import/export，不要引用其它模块或构建期变量；只用 ES5 语法，
 *    所有补丁都必须做特性检测，保证现代浏览器上完全是 no-op。
 */
;(function () {
  'use strict'

  // ── 极老环境的基础设施 ────────────────────────────────────────────────
  if (typeof globalThis === 'undefined') {
    // eslint-disable-next-line no-global-assign
    this.globalThis = this
  }
  if (typeof queueMicrotask !== 'function') {
    var resolved = Promise.resolve()
    globalThis.queueMicrotask = function (cb) {
      resolved.then(cb).catch(function (err) {
        setTimeout(function () {
          throw err
        }, 0)
      })
    }
  }

  function define(target, name, value) {
    try {
      Object.defineProperty(target, name, {
        value: value,
        writable: true,
        enumerable: false,
        configurable: true,
      })
    } catch (e) {
      try {
        target[name] = value
      } catch (e2) {
        /* 补不上就算了，不影响现代浏览器 */
      }
    }
  }

  function aggregateErrors(errors) {
    if (typeof AggregateError === 'function') {
      return new AggregateError(errors, 'All promises were rejected')
    }
    var err = new Error('All promises were rejected')
    err.name = 'AggregateError'
    err.errors = errors
    return err
  }

  /** 把字符串 needle 转成可安全塞进 RegExp 的形式（replaceAll 补丁用） */
  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function iterableToArray(iterable) {
    if (typeof Array.from === 'function') return Array.from(iterable)
    var out = []
    if (!iterable) return out
    if (typeof iterable.length === 'number') {
      for (var i = 0; i < iterable.length; i++) out.push(iterable[i])
      return out
    }
    if (typeof iterable[Symbol.iterator] === 'function') {
      var it = iterable[Symbol.iterator]()
      var step = it.next()
      while (!step.done) {
        out.push(step.value)
        step = it.next()
      }
    }
    return out
  }

  // ── Promise：本次 PDF 打开失败的根因就在这里 ──────────────────────────
  if (typeof Promise === 'function') {
    if (typeof Promise.withResolvers !== 'function') {
      define(Promise, 'withResolvers', function withResolvers() {
        var resolve, reject
        var promise = new Promise(function (res, rej) {
          resolve = res
          reject = rej
        })
        return { promise: promise, resolve: resolve, reject: reject }
      })
    }

    if (typeof Promise.any !== 'function') {
      define(Promise, 'any', function any(iterable) {
        return new Promise(function (resolve, reject) {
          var items = iterableToArray(iterable)
          if (items.length === 0) {
            reject(aggregateErrors([]))
            return
          }
          var errors = new Array(items.length)
          var remaining = items.length
          var settled = false
          items.forEach(function (item, index) {
            Promise.resolve(item).then(
              function (value) {
                if (settled) return
                settled = true
                resolve(value)
              },
              function (err) {
                errors[index] = err
                remaining -= 1
                if (remaining === 0 && !settled) {
                  settled = true
                  reject(aggregateErrors(errors))
                }
              },
            )
          })
        })
      })
    }

    if (typeof Promise.allSettled !== 'function') {
      define(Promise, 'allSettled', function allSettled(iterable) {
        return Promise.all(
          iterableToArray(iterable).map(function (item) {
            return Promise.resolve(item).then(
              function (value) {
                return { status: 'fulfilled', value: value }
              },
              function (reason) {
                return { status: 'rejected', reason: reason }
              },
            )
          }),
        )
      })
    }

    if (typeof Promise.try !== 'function') {
      define(Promise, 'try', function promiseTry(fn) {
        var args = Array.prototype.slice.call(arguments, 1)
        return new Promise(function (resolve) {
          resolve(fn.apply(undefined, args))
        })
      })
    }
  }

  // ── Array / String 上的 ES2022+ 方法 ────────────────────────────────
  if (typeof Array.prototype.at !== 'function') {
    define(Array.prototype, 'at', function at(index) {
      var len = this.length >>> 0
      var i = Math.trunc(index) || 0
      if (i < 0) i += len
      return i < 0 || i >= len ? undefined : this[i]
    })
  }
  if (typeof String.prototype.at !== 'function') {
    define(String.prototype, 'at', function at(index) {
      var str = String(this)
      var i = Math.trunc(index) || 0
      if (i < 0) i += str.length
      return i < 0 || i >= str.length ? undefined : str.charAt(i)
    })
  }
  if (typeof Array.prototype.findLast !== 'function') {
    define(Array.prototype, 'findLast', function findLast(predicate, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (predicate.call(thisArg, this[i], i, this)) return this[i]
      }
      return undefined
    })
  }
  if (typeof Array.prototype.findLastIndex !== 'function') {
    define(Array.prototype, 'findLastIndex', function findLastIndex(predicate, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (predicate.call(thisArg, this[i], i, this)) return i
      }
      return -1
    })
  }
  ;[
    ['toReversed', function () {
      return this.slice().reverse()
    }],
    ['toSorted', function (compareFn) {
      return this.slice().sort(compareFn)
    }],
    ['toSpliced', function () {
      var copy = this.slice()
      copy.splice.apply(copy, arguments)
      return copy
    }],
    ['with', function (index, value) {
      var copy = this.slice()
      var i = Math.trunc(index) || 0
      if (i < 0) i += copy.length
      if (i < 0 || i >= copy.length) throw new RangeError('Invalid index')
      copy[i] = value
      return copy
    }],
  ].forEach(function (entry) {
    if (typeof Array.prototype[entry[0]] !== 'function') {
      define(Array.prototype, entry[0], entry[1])
    }
  })

  if (typeof String.prototype.replaceAll !== 'function') {
    define(String.prototype, 'replaceAll', function replaceAll(search, replacement) {
      if (search instanceof RegExp) {
        if (!search.global) {
          throw new TypeError('replaceAll must be called with a global RegExp')
        }
        return String(this).replace(search, replacement)
      }
      var str = String(this)
      var needle = String(search)
      // 空 needle：在每个字符前后各插入一次（原生 replaceAll('') 的语义）
      if (needle === '') return str.replace(/(?:)/g, replacement)
      // 交给原生 replace 处理：它已经实现了 $$ / $& / $` / $' 等替换模式语义，
      // 自己拼字符串反而容易在这上面出错（split/join 会把 $& 当字面量）。
      return str.replace(new RegExp(escapeRegExp(needle), 'g'), replacement)
    })
  }

  // ── Object / Map / Set / URL / AbortSignal ─────────────────────────
  if (typeof Object.hasOwn !== 'function') {
    define(Object, 'hasOwn', function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key)
    })
  }
  if (typeof Object.fromEntries !== 'function') {
    define(Object, 'fromEntries', function fromEntries(iterable) {
      var out = {}
      iterableToArray(iterable).forEach(function (pair) {
        out[pair[0]] = pair[1]
      })
      return out
    })
  }

  function groupByPolyfill(iterable, callback) {
    var out = new Map()
    var index = 0
    iterableToArray(iterable).forEach(function (item) {
      var key = callback(item, index++)
      var bucket = out.get(key)
      if (bucket) bucket.push(item)
      else out.set(key, [item])
    })
    return out
  }
  function groupByToObject(iterable, callback) {
    var map = groupByPolyfill(iterable, callback)
    var out = {}
    map.forEach(function (value, key) {
      out[key] = value
    })
    return out
  }
  if (typeof Object.groupBy !== 'function') define(Object, 'groupBy', groupByToObject)
  if (typeof Map.groupBy !== 'function') define(Map, 'groupBy', groupByPolyfill)

  if (typeof Set === 'function' && typeof Set.prototype.union !== 'function') {
    function toSet(other) {
      return other instanceof Set ? other : new Set(other)
    }
    define(Set.prototype, 'union', function union(other) {
      var out = new Set(this)
      toSet(other).forEach(function (v) {
        out.add(v)
      })
      return out
    })
    define(Set.prototype, 'intersection', function intersection(other) {
      var out = new Set()
      var rhs = toSet(other)
      this.forEach(function (v) {
        if (rhs.has(v)) out.add(v)
      })
      return out
    })
    define(Set.prototype, 'difference', function difference(other) {
      var out = new Set(this)
      toSet(other).forEach(function (v) {
        out.delete(v)
      })
      return out
    })
    define(Set.prototype, 'symmetricDifference', function symmetricDifference(other) {
      var out = new Set(this)
      toSet(other).forEach(function (v) {
        if (out.has(v)) out.delete(v)
        else out.add(v)
      })
      return out
    })
    define(Set.prototype, 'isSubsetOf', function isSubsetOf(other) {
      var rhs = toSet(other)
      var ok = true
      this.forEach(function (v) {
        if (!rhs.has(v)) ok = false
      })
      return ok
    })
    define(Set.prototype, 'isSupersetOf', function isSupersetOf(other) {
      var self = this
      var ok = true
      toSet(other).forEach(function (v) {
        if (!self.has(v)) ok = false
      })
      return ok
    })
    define(Set.prototype, 'isDisjointFrom', function isDisjointFrom(other) {
      var rhs = toSet(other)
      var ok = true
      this.forEach(function (v) {
        if (rhs.has(v)) ok = false
      })
      return ok
    })
  }

  if (typeof URL === 'function' && typeof URL.canParse !== 'function') {
    define(URL, 'canParse', function canParse(url, base) {
      try {
        // eslint-disable-next-line no-new
        new URL(url, base)
        return true
      } catch (e) {
        return false
      }
    })
  }

  if (
    typeof AbortSignal === 'function' &&
    typeof AbortSignal.timeout !== 'function' &&
    typeof AbortController === 'function'
  ) {
    define(AbortSignal, 'timeout', function timeout(ms) {
      var controller = new AbortController()
      setTimeout(function () {
        var reason
        if (typeof DOMException === 'function') {
          reason = new DOMException('The operation timed out.', 'TimeoutError')
        } else {
          reason = new Error('The operation timed out.')
          reason.name = 'TimeoutError'
        }
        controller.abort(reason)
      }, ms)
      return controller.signal
    })
  }

  // ── structuredClone（Chrome 98+）：pdfjs 用它做消息拷贝 ────────────────
  if (typeof globalThis.structuredClone !== 'function') {
    var cloneValue = function (value, seen) {
      if (value === null || typeof value !== 'object') return value
      if (seen.has(value)) return seen.get(value)

      if (value instanceof Date) return new Date(value.getTime())
      if (value instanceof RegExp) return new RegExp(value.source, value.flags)
      if (typeof ArrayBuffer === 'function') {
        if (value instanceof ArrayBuffer) return value.slice(0)
        if (ArrayBuffer.isView && ArrayBuffer.isView(value)) {
          if (value instanceof DataView) {
            return new DataView(cloneValue(value.buffer, seen), value.byteOffset, value.byteLength)
          }
          return new value.constructor(value)
        }
      }

      if (Array.isArray(value)) {
        var arr = []
        seen.set(value, arr)
        for (var i = 0; i < value.length; i++) arr[i] = cloneValue(value[i], seen)
        return arr
      }
      if (typeof Map === 'function' && value instanceof Map) {
        var map = new Map()
        seen.set(value, map)
        value.forEach(function (v, k) {
          map.set(cloneValue(k, seen), cloneValue(v, seen))
        })
        return map
      }
      if (typeof Set === 'function' && value instanceof Set) {
        var set = new Set()
        seen.set(value, set)
        value.forEach(function (v) {
          set.add(cloneValue(v, seen))
        })
        return set
      }
      if (value instanceof Error) {
        var err = new value.constructor(value.message)
        err.name = value.name
        if (value.stack) err.stack = value.stack
        return err
      }

      var out = {}
      seen.set(value, out)
      Object.keys(value).forEach(function (key) {
        out[key] = cloneValue(value[key], seen)
      })
      return out
    }
    define(globalThis, 'structuredClone', function structuredClone(value) {
      return cloneValue(value, new Map())
    })
  }
})()
