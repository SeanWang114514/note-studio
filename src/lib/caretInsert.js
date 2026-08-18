/**
 * contentEditable / textarea 光标选区捕获与文本插入工具
 * 供 OCR「插入到文档」功能使用。
 */

/**
 * 捕获 contenteditable 根元素内的当前选区（Range）。
 * 没有选区时返回文末 Range；元素不可用时返回 null。
 * @param {HTMLElement} root
 * @returns {{ kind: 'range', range: Range } | null}
 */
export function captureEditableSelection(root) {
  if (!root) return null
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0 && root.contains(sel.anchorNode) && root.contains(sel.focusNode)) {
    return { kind: 'range', range: sel.getRangeAt(0).cloneRange() }
  }
  const r = document.createRange()
  r.selectNodeContents(root)
  r.collapse(false)
  return { kind: 'range', range: r }
}

/**
 * 在指定 Range 处插入文本（优先 execCommand 以获得原生 input 事件与撤销栈，
 * 失败时手动插入文本节点）。
 * @param {Range} range
 * @param {string} text
 * @returns {boolean}
 */
export function insertAtRange(range, text) {
  if (!range || text == null) return false
  const sel = window.getSelection()
  if (!sel) return false
  sel.removeAllRanges()
  sel.addRange(range)
  try {
    const ok = document.execCommand('insertText', false, text)
    if (ok) return true
  } catch {
    /* 继续手动插入 */
  }
  const r = sel.rangeCount ? sel.getRangeAt(0) : range
  r.deleteContents()
  const node = document.createTextNode(text)
  r.insertNode(node)
  r.setStartAfter(node)
  r.collapse(false)
  return true
}

/**
 * 捕获 textarea 的光标位置。
 * @param {HTMLTextAreaElement} ta
 * @param {number} fallbackEnd 无选区时的回退长度
 * @returns {{start: number, end: number}}
 */
export function captureTextareaSelection(ta, fallbackEnd = 0) {
  if (!ta) return { start: fallbackEnd, end: fallbackEnd }
  const start = ta.selectionStart ?? fallbackEnd
  const end = ta.selectionEnd ?? start
  return { start, end }
}
