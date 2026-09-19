import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'

/**
 * 「删除新建页」按钮 —— 自带二级确定（两次点击），不弹窗、不打断连续操作。
 *
 * 交互：
 *   第一次点击只是「上膛」：按钮变成警示色的「确认删除」，3 秒内再点一次才真的执行；
 *   期间点到别处（失焦）、超时、或按钮被置灰都会自动收回，所以误点一下不会删掉任何东西。
 *
 * 为什么不用 window.confirm：这个按钮就在工具栏里，跟「新建一页」挨着，用户是按「撤销」的
 * 心态来点的；弹窗会把连续操作打断，远不如「同一个按钮再点一次」轻快。
 * 真正不可逆的破坏（例如批量删批注）才值得动用弹窗。
 *
 * @param {() => void} onConfirm 第二次点击时执行
 * @param {boolean} disabled 没有「自己新建过的页」时置灰
 * @param {string} title 未上膛时的提示文案
 * @param {boolean} busy 正在删除中（按钮显示「删除中…」）
 * @param {string} label 默认「删除新建页」
 */
export default function DeletePageButton({ onConfirm, disabled = false, title, busy = false, label = '删除新建页' }) {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef(null)
  const disarm = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setArmed(false)
  }, [])
  // 卸载时清掉倒计时，避免「已走的组件里 setState」
  useEffect(() => () => clearTimeout(timerRef.current), [])
  // 变成不可用时（例如刚删完、或换了文件）立刻收回确认态
  useEffect(() => {
    if (disabled) disarm()
  }, [disabled, disarm])

  const onClick = () => {
    if (disabled || busy) return
    if (!armed) {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setArmed(false)
      }, 3000)
      setArmed(true)
      return
    }
    disarm()
    onConfirm()
  }

  return (
    <button
      type="button"
      className={`tool-btn new-page-btn danger${armed ? ' is-armed' : ''}`}
      // data-armed 供自动化验收断言「二级确定」确实拦了一步
      data-armed={armed ? '1' : '0'}
      title={armed ? '再点一次确认删除（3 秒内有效，点别处即取消）' : title || label}
      onClick={onClick}
      onBlur={disarm}
      disabled={disabled || busy}
    >
      <Trash2 size={15} />
      <span className="btn-text">{busy ? '删除中…' : armed ? '确认删除' : label}</span>
    </button>
  )
}
