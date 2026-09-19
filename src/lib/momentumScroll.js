// momentumScroll.js — 触屏滑动惯性（fling）
//
// 画布是 touch-action:none（画笔必须如此），所以文档滚动是我们自己在 pointermove 里搬
// scrollTop 的。但手指一松文档就立刻停住，手感像「拖不动」；这里补上原生滚动的手感：
// 松手时按最后几次采样的速度继续滚，指数衰减到停，撞到边界的那一轴立刻停下。

const MIN_FLING = 0.12 // px/ms：低于这个速度不甩（慢拖松手不该继续滑）
const MAX_FLING = 6 // px/ms：上限，防止个别跳变采样把页面甩飞
const DECAY_PER_16MS = 0.94 // 每 16ms 衰减比例（帧率无关）
const STOP_SPEED = 0.02 // px/ms：低于这个速度收工

/**
 * 速度采样器：记录最近若干次移动，松手时按最近 100ms 的位移算速度。
 * 原生列表的 fling 也是这么做的 —— 只看最后一段，否则慢拖之后的急停会被算成高速。
 */
export function createVelocityTracker() {
  let samples = []
  return {
    reset() {
      samples = []
    },
    add(x, y, t = performance.now()) {
      samples.push({ x, y, t })
      if (samples.length > 12) samples.shift()
    },
    /** @returns {{vx:number, vy:number}} px/ms */
    velocity(now = performance.now()) {
      if (samples.length < 2) return { vx: 0, vy: 0 }
      const recent = samples.filter((s) => now - s.t <= 100)
      const list = recent.length >= 2 ? recent : samples.slice(-2)
      const first = list[0]
      const last = list[list.length - 1]
      const dt = last.t - first.t
      if (!(dt > 0)) return { vx: 0, vy: 0 }
      const clamp = (v) => Math.max(-MAX_FLING, Math.min(MAX_FLING, v))
      return {
        vx: clamp((last.x - first.x) / dt),
        vy: clamp((last.y - first.y) / dt),
      }
    },
  }
}

/**
 * 按速度让滚动容器继续滚（惯性）。
 * @param {HTMLElement} scroller 滚动容器
 * @param {number} vx 水平速度（px/ms，正数=内容继续向左）
 * @param {number} vy 垂直速度（px/ms，正数=继续向下滚）
 * @param {{onStop?: () => void}} [opts]
 * @returns {() => void} 取消函数（新触摸按下 / 卸载时调用）
 */
export function startMomentumScroll(scroller, vx, vy, opts = {}) {
  if (!scroller) return () => {}
  let speedX = Number.isFinite(vx) ? vx : 0
  let speedY = Number.isFinite(vy) ? vy : 0
  if (Math.hypot(speedX, speedY) < MIN_FLING) return () => {}

  let raf = 0
  let stopped = false
  let last = performance.now()
  const stop = () => {
    if (stopped) return
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    opts.onStop?.()
  }
  const step = (now) => {
    if (stopped) return
    const dt = Math.min(32, Math.max(1, now - last))
    last = now
    const decay = Math.pow(DECAY_PER_16MS, dt / 16)
    speedX *= decay
    speedY *= decay
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const nextTop = Math.max(0, Math.min(maxTop, scroller.scrollTop + speedY * dt))
    const nextLeft = Math.max(0, Math.min(maxLeft, scroller.scrollLeft + speedX * dt))
    // 撞到边界：该轴速度清零（否则会在边缘一直「空转」到衰减结束）
    const hitY = Math.abs(nextTop - scroller.scrollTop) < 0.01 && Math.abs(speedY) > 0.01
    const hitX = Math.abs(nextLeft - scroller.scrollLeft) < 0.01 && Math.abs(speedX) > 0.01
    scroller.scrollTop = nextTop
    scroller.scrollLeft = nextLeft
    if (hitY) speedY = 0
    if (hitX) speedX = 0
    if (Math.hypot(speedX, speedY) < STOP_SPEED) {
      stop()
      return
    }
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return stop
}
