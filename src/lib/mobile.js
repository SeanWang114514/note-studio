// mobile.js — 移动端（APK / 触屏窄屏）判定与标记
//
// 为什么单独判定：这个应用原本是桌面优先的（鼠标 + 键盘 + 常驻侧栏）。打包成 APK 后
// 有几件事必须按触屏来做：
//   1) 单指滑动滚动文档 + 松手惯性（画布是 touch-action:none，浏览器不会替我们滚）
//   2) 打开文档 / 旋转屏幕时按屏幕尺寸自动适配缩放
//   3) 批注栏、缩略图栏在窄屏默认折叠，否则 412px 的手机上文档区只剩一百多像素
// 这些都只应在移动端生效 —— 桌面端行为必须一点不变，所以统一从这里取判定。

let cached = null

/** Capacitor 原生壳（APK）判定：注入的 window.Capacitor 优先 */
function isNativeShell() {
  try {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null
    if (!cap) return false
    if (typeof cap.isNativePlatform === 'function') return Boolean(cap.isNativePlatform())
    if (typeof cap.getPlatform === 'function') return cap.getPlatform() !== 'web'
  } catch {
    // 取不到就当作不是原生壳
  }
  return false
}

function computeIsMobile() {
  if (typeof window === 'undefined') return false
  // 1) 原生 APK：无脑按移动端
  if (isNativeShell()) return true
  // 2) 显式开关（自动化测试 / 调试用）
  if (window.__NOTE_FORCE_MOBILE__ === true) return true
  try {
    if (new URLSearchParams(window.location.search).get('mobile') === '1') return true
  } catch {
    // 拿不到 query 就继续按环境判断
  }
  // 3) 触屏 + 主指针为 coarse + 屏幕短边 ≤ 900 → 当手机/平板看待。
  //    桌面即便带触摸屏，主指针通常仍是 fine（鼠标），这里不命中，行为不变。
  const touch = (navigator.maxTouchPoints || 0) > 0
  if (!touch) return false
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false
  const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0)
  return coarse && shortSide > 0 && shortSide <= 900
}

/** 是否按移动端触屏交互（结果缓存：环境在一次会话里不会变） */
export function isMobileShell() {
  if (cached === null) cached = computeIsMobile()
  return cached
}

/** 把移动端标记写到 <html data-mobile="1">，供 CSS 使用；返回是否移动端 */
export function tagMobileShell() {
  const mobile = isMobileShell()
  try {
    const el = document.documentElement
    if (mobile) el.setAttribute('data-mobile', '1')
    else el.removeAttribute('data-mobile')
  } catch {
    // 无 document（SSR/测试）时忽略
  }
  return mobile
}

/** 重新判定（视口或开关变化后调用） */
export function resetMobileShellCache() {
  cached = null
}
