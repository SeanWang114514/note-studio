import { useCallback, useEffect, useState } from 'react'

/**
 * 「自己新建过的页」记账本 —— 给「删除新建页」做撤销用（后进先出）。
 *
 * 只记本会话里、由「新建一页」按钮产生的页；换文件（entryId 变化）立刻清空：
 * 换了文档就不该再能撤销上一个文档加过的页。
 *
 * 每次新建时把「足够定位这一页」的信息 push 进来，各视图按自己的格式去用：
 *   PDF      → { pageCount }            加完之后的页数
 *   Word     → { }                      分页标记永远在文末，不需要额外信息
 *   Markdown → { ids: [块 id, 空段落 id] }
 *   EPUB     → { path, markup }         新章节路径 + 插进正文的那段 HTML
 *   Excel    → { id, name }             新工作表的 id
 *   纯文本   → { at, insert }           插入位置与插入的那段文本
 *   白板     → 直接记页数（见 useWhiteboardPages）
 *
 * @param {string} entryId 当前文件 id：变了就清空
 */
export default function useNewPageUndo(entryId) {
  const [stack, setStack] = useState([])

  useEffect(() => {
    setStack([])
  }, [entryId])

  const push = useCallback((info) => setStack((s) => [...s, info]), [])
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const reset = useCallback(() => setStack([]), [])

  // 最近一次新建的记录：撤销总是从最后一次开始
  const last = stack.length ? stack[stack.length - 1] : null
  return { stack, last, canUndo: stack.length > 0, push, pop, reset }
}
