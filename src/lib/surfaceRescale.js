// surfaceRescale.js — 「新建一页」之后的批注纵向重标定
//
// 背景：批注坐标是「相对整篇文档表面」归一化的（x、y 都是 0~1，y 相对整个
// .annot-surface 的高度，见 App.jsx 的 syncCanvasGeometry）。新增一页会让文档
// 表面变高，而内容只从下往上堆：既有批注的归一化 y 在新高度下会被放大，
// 屏幕上表现为「墨迹整体往下滑、离开了原来那一页」。
//
// 这里提供两件事：
//   1. rescaleAnnotationY(list, ratio)：把批注的纵向坐标乘以 ratio（旧高/新高），
//      换算后墨迹的绝对像素位置保持不变；
//   2. useSurfaceRescale(surfaceRef, onSettle)：记下「加页前的高度」，轮询等表面
//      高度稳定后回调 ratio —— 各视图共用同一套路，不必各自写计时器。
//
// 只动纵向坐标：x 与文档宽度无关，加页不会改变宽度。

import { useCallback, useEffect, useRef } from 'react'

/**
 * 按 ratio（旧高度 / 新高度）缩放批注的纵向坐标。
 * 覆盖所有批注类型的 y 字段：points(y)、y0/y1、文本框的 y 与高度 h、批注标记的 y。
 * @param {Array<object>} list 批注列表（返回新数组，不改原对象）
 * @param {number} ratio 旧高 / 新高，接近 1 时原样返回
 */
export function rescaleAnnotationY(list, ratio) {
  const r = Number(ratio)
  if (!Array.isArray(list) || !Number.isFinite(r) || r <= 0 || Math.abs(r - 1) < 1e-4) {
    return list
  }
  return list.map((a) => {
    if (!a) return a
    const next = { ...a }
    if (typeof a.y === 'number') next.y = a.y * r
    if (typeof a.h === 'number') next.h = a.h * r
    if (typeof a.y0 === 'number') next.y0 = a.y0 * r
    if (typeof a.y1 === 'number') next.y1 = a.y1 * r
    if (Array.isArray(a.points)) {
      next.points = a.points.map((p) => (p && typeof p.y === 'number' ? { ...p, y: p.y * r } : p))
    }
    return next
  })
}

/**
 * 生成「新增一页之后」的结算回调（各视图共用）。
 *
 * 三条克制，都是踩过的坑：
 * 1. 没有批注就直接返回 —— 空的 applyList 会让 annotations 换新对象，下游 memo/effect
 *    连锁重建（Word 视图的正文是按 html state 重建 DOM 的，一重建就把用户正在输入的
 *    内容和刚插入的分页标记一起冲掉）；
 * 2. 比例≈1 时 rescaleAnnotationY 会原样返回，同样不提交；
 * 3. 走 applyList（不记撤销历史）—— 这是「加页」引起的几何补偿，不是一次用户编辑。
 *    记进历史的话，Ctrl+Z 会把坐标还原而页面还在，墨迹反而错位。
 *
 * @param {object} tools useAnnotTools 的返回值
 */
export function makeSurfaceRescaleSettler(tools) {
  return (ratio) => {
    const list = (tools?.annRef?.current?.[tools.annKey]) || []
    if (!list.length) return
    const next = rescaleAnnotationY(list, ratio)
    if (next === list) return
    const apply = tools.applyList || tools.setList
    apply(next)
  }
}

/**
 * 观察批注表面的高度变化，结算出「旧高 / 新高」。
 * 用法：把 surfaceRef 挂到 .annot-surface 元素上（与批注层同一父级），
 * 在「新增一页」之前调用返回的 markBefore()。之后每 50ms 量一次高度，
 * 等到高度确实变大、并连续 3 次（约 150ms）不再变化时回调一次 onSettle(ratio)；
 * 3 秒内没等到变化就放弃（例如加页失败、或该格式不改变表面高度）。
 *
 * @param {{current: HTMLElement|null}} surfaceRef 批注表面元素
 * @param {(ratio: number) => void} onSettle 结算回调（ratio = 旧高 / 新高）
 * @returns {() => void} markBefore
 */
export function useSurfaceRescale(surfaceRef, onSettle) {
  const timerRef = useRef(0)
  const settleRef = useRef(onSettle)
  // 每次渲染刷新回调：结算发生在计时器里，必须拿到最新的闭包（最新的批注列表）
  settleRef.current = onSettle

  useEffect(() => () => clearInterval(timerRef.current), [])

  return useCallback(() => {
    clearInterval(timerRef.current)
    const h0 = surfaceRef.current?.clientHeight || 0
    if (!h0) return
    let last = h0
    let stable = 0
    let ticks = 0
    timerRef.current = setInterval(() => {
      ticks += 1
      // 每次都重新取元素：视图重渲染可能换掉 DOM 节点
      const h = surfaceRef.current?.clientHeight || 0
      if (h === last) stable += 1
      else {
        stable = 0
        last = h
      }
      // 至少要比原来高，且已经稳定；ticks 上限兜底，避免计时器常驻
      if ((h > h0 && stable >= 3) || ticks > 60) {
        clearInterval(timerRef.current)
        timerRef.current = 0
        if (h > h0) settleRef.current?.(h0 / h)
      }
    }, 50)
  }, [surfaceRef])
}
