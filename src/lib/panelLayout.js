// panelLayout.js — 侧栏类栏目的「自由缩放 + 折叠收起」布局 store
//
// 设计：
// - 单一模块级 store + useSyncExternalStore，任何组件都能直接读写，不必层层传 props；
// - 每个栏目记录 { width, collapsed }，宽度按 min/max 夹取；
// - localStorage 持久化（跨会话记住用户的栏宽），读写都做容错，坏数据回落到默认值；
// - 键盘/无障碍与 Apple HIG 分隔条一致：role="separator"、方向键微调、双击复位。

import { useCallback, useSyncExternalStore } from 'react'
import { isMobileShell } from './mobile.js'

export const PANEL_DEFAULTS = {
  // 应用左侧边栏（源列表）
  sidebar: { width: 232, min: 180, max: 460, collapsed: false },
  // PDF 缩略图栏
  // 136/124：标题行是「页面」胶囊 + 页数胶囊 + 右上角折叠按钮（图标 16px、按钮 24px），
  // 三者加起来约 86px，再加上两边 10px 内边距和右边界，面板窄于 124px 时按钮会被 overflow 裁掉。
  // 手机（≤760px）默认折叠：屏幕就 390px 宽，缩略图栏 + 批注栏各占 136/268px 后页面宽度只剩 0，
  // 用户可从工具栏的「隐藏/显示缩略图栏」按钮随时打开（手机上折叠细栏本身是隐藏的）。
  pdfThumbs: { width: 136, min: 124, max: 300, collapsed: isNarrowViewport() },
  // 右侧批注栏（所有文档视图共用）
  // 手机（≤760px）默认折叠：412px 的屏上批注栏占 268px，文档区只剩 144px ——
  // 页面既装不下也看不清，「按屏幕自动适配」无从谈起。用户点折叠条上的按钮随时能展开。
  annPanel: { width: 268, min: 200, max: 520, collapsed: isNarrowViewport() },
}

// 模块加载时的视口宽度决定「首次打开」的默认布局（仅在没有用户已保存偏好的时候生效）
function isNarrowViewport() {
  if (typeof window === 'undefined') return false
  // 原生 APK 一律按窄屏处理：横屏时 innerWidth 可能 900+，但仍是触屏手机/平板
  return isMobileShell() || window.innerWidth <= 760
}

const STORAGE_KEY = 'note-studio.panel-layout.v1'

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalize(raw) {
  const out = {}
  for (const [key, def] of Object.entries(PANEL_DEFAULTS)) {
    const saved = raw && typeof raw === 'object' ? raw[key] : null
    const hasSaved = Boolean(saved && typeof saved === 'object')
    out[key] = {
      width: clamp(hasSaved && saved.width != null ? saved.width : def.width, def.min, def.max),
      // 注意：不能写成 Boolean(saved?.collapsed) —— 没有存档时那是 Boolean(undefined)=false，
      // 会把「按屏宽算出来的默认折叠状态」（手机默认收起缩略图栏）直接吞掉。
      collapsed: hasSaved && typeof saved.collapsed === 'boolean' ? saved.collapsed : Boolean(def.collapsed),
    }
  }
  return out
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalize(raw ? JSON.parse(raw) : null)
  } catch {
    return normalize(null)
  }
}

let state = load()
const listeners = new Set()

function commit(next) {
  state = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式/配额满：布局只在本次会话生效，不影响功能
  }
  for (const l of listeners) l()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return state
}

export function setPanelWidth(key, width) {
  const def = PANEL_DEFAULTS[key]
  if (!def) return
  commit({ ...state, [key]: { ...state[key], width: clamp(width, def.min, def.max) } })
}

export function togglePanel(key) {
  if (!PANEL_DEFAULTS[key]) return
  commit({ ...state, [key]: { ...state[key], collapsed: !state[key].collapsed } })
}

export function setPanelCollapsed(key, collapsed) {
  if (!PANEL_DEFAULTS[key]) return
  commit({ ...state, [key]: { ...state[key], collapsed: Boolean(collapsed) } })
}

export function resetPanel(key) {
  const def = PANEL_DEFAULTS[key]
  if (!def) return
  commit({ ...state, [key]: { width: def.width, collapsed: false } })
}

/** 组件用法：const panel = usePanel('sidebar') → { width, collapsed, min, max, setWidth, toggle, reset } */
export function usePanel(key) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const current = snapshot[key] || PANEL_DEFAULTS[key]
  const def = PANEL_DEFAULTS[key]
  return {
    key,
    width: current.width,
    collapsed: current.collapsed,
    min: def.min,
    max: def.max,
    defaultWidth: def.width,
    setWidth: useCallback((w) => setPanelWidth(key, w), [key]),
    toggle: useCallback(() => togglePanel(key), [key]),
    setCollapsed: useCallback((c) => setPanelCollapsed(key, c), [key]),
    reset: useCallback(() => resetPanel(key), [key]),
  }
}
