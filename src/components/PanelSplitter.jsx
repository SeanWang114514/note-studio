// PanelSplitter.jsx — 可拖拽的栏目分隔条（Apple HIG 分隔条 + 键盘可达）
//
// - edge="right"：分隔条贴在栏目右边缘（左侧栏目，如侧边栏/缩略图栏）→ 右拖变宽
// - edge="left" ：分隔条贴在栏目左边缘（右侧栏目，如批注栏）→ 左拖变宽
// - 方向键微调（Shift 加速）、Home/End 到最小/最大、Enter/Space 折叠、双击复位默认宽度
// - 拖动期间给 body 加 resizing 类，避免文本被选中、光标闪烁

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePanel } from '../lib/panelLayout.js'

const STEP = 12
const STEP_BIG = 48

export function PanelSplitter({ panel, edge = 'right', title = '拖动调整宽度（双击恢复默认，回车折叠）' }) {
  const p = usePanel(panel)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)

  const applyFromClientX = useCallback(
    (clientX) => {
      const start = dragRef.current
      if (!start) return
      const delta = clientX - start.clientX
      p.setWidth(edge === 'right' ? start.width + delta : start.width - delta)
    },
    [edge, p],
  )

  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (e) => {
      e.preventDefault()
      applyFromClientX(e.clientX)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.body.classList.add('panel-resizing')
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('panel-resizing')
    }
  }, [dragging, applyFromClientX])

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { clientX: e.clientX, width: p.width }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 指针捕获失败也能靠 window 监听完成拖动
    }
    setDragging(true)
  }

  const onKeyDown = (e) => {
    const big = e.shiftKey ? STEP_BIG : STEP
    // 方向键语义跟「分隔条移动方向」一致：左侧栏目右边缘的分隔条，→ 变宽
    const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key === grow) {
      e.preventDefault()
      p.setWidth(p.width + big)
    } else if (e.key === shrink) {
      e.preventDefault()
      p.setWidth(p.width - big)
    } else if (e.key === 'Home') {
      e.preventDefault()
      p.setWidth(p.min)
    } else if (e.key === 'End') {
      e.preventDefault()
      p.setWidth(p.max)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      p.toggle()
    }
  }

  return (
    <div
      className={`panel-splitter ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={title}
      aria-valuenow={p.width}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      tabIndex={0}
      title={title}
      onPointerDown={onPointerDown}
      onDoubleClick={() => p.reset()}
      onKeyDown={onKeyDown}
    >
      <span className="panel-splitter-grip" aria-hidden="true" />
    </div>
  )
}

export default PanelSplitter
