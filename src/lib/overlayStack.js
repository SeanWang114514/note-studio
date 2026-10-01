// overlayStack.js — 弹层栈（APK 的 Android 返回键用）。
//
// Capacitor 里返回键默认是「没 JS 监听就直接退出」，用户一按连着弹层一起杀。
// 这里维护一个「可被返回键关闭」的弹层栈：返回键先关最上面一层（和 Esc 同语义），
// 栈空了才允许 history 回退 / 退出应用。注册方用 useOverlay(open, close)，
// 组件只管自己的开关，不需要互相知道对方的存在。
import { useEffect, useRef } from 'react'

/** 栈内条目按「打开顺序」排列，closeTopOverlay 关最上面的 */
const stack = []

/** 手动注册一个弹层，返回反注册函数（一般直接用 useOverlay） */
export function pushOverlay(close) {
  const entry = { close }
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
  }
}

/**
 * 关掉最上层弹层。
 * @returns {boolean} true = 这次返回键被消费掉了（有弹层被要求关闭）
 */
export function closeTopOverlay() {
  const entry = stack.pop()
  if (!entry) return false
  try {
    entry.close()
  } catch {
    // 关闭失败也不该把返回键变成崩溃
  }
  return true
}

/**
 * 声明式注册：open 为 true 期间占据栈顶，卸载/关闭自动退出栈。
 * close 走 ref —— onClose 几乎都是行内箭头函数，每次渲染都换身份，
 * 直接当依赖会让弹层反复进出栈（把「后开的」排到「先开的」下面去）。
 */
export function useOverlay(open, close) {
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })
  useEffect(() => {
    if (!open) return undefined
    return pushOverlay(() => closeRef.current())
  }, [open])
}
