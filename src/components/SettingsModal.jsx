import { useEffect, useState } from 'react'
import { LayoutPanelLeft, RotateCcw, Settings, X } from 'lucide-react'
import { PANEL_DEFAULTS, resetPanel, usePanel } from '../lib/panelLayout.js'

/**
 * 设置弹窗：窗口与面板布局。
 * （语音识别模型 / 手写识别模型相关配置已按需求整体移除。）
 */
export default function SettingsModal({ open, onClose, notify }) {
  const sidebar = usePanel('sidebar')
  const thumbs = usePanel('pdfThumbs')
  const annPanel = usePanel('annPanel')
  const [done, setDone] = useState('')

  useEffect(() => {
    if (!open) return
    setDone('')
  }, [open])

  if (!open) return null

  const flash = (msg) => {
    setDone(msg)
    notify?.(msg, 'success')
    setTimeout(() => setDone(''), 1600)
  }

  const resetAll = () => {
    resetPanel('sidebar')
    resetPanel('pdfThumbs')
    resetPanel('annPanel')
    flash('面板布局已恢复默认')
  }

  const panels = [
    { key: 'sidebar', label: '左侧边栏', panel: sidebar },
    { key: 'pdfThumbs', label: '页面缩略图栏', panel: thumbs },
    { key: 'annPanel', label: '右侧批注栏', panel: annPanel },
  ]

  return (
    <div
      className="ocr-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="ocr-modal-header">
          <div className="ocr-title">
            <Settings size={17} color="currentColor" />
            <span>设置</span>
          </div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="settings-section-title">窗口与面板</h3>
            <p className="settings-hint">
              三条栏的宽度都能直接拖动分隔条调整（双击分隔条恢复默认宽度，回车折叠）。这里可以一键重置或逐个显示/隐藏。
            </p>
            {panels.map(({ key, label, panel }) => (
              <label key={key} className="settings-panel-row">
                <span className="ocr-model-label">
                  <LayoutPanelLeft size={13} />
                  {label}
                </span>
                <span className="settings-panel-meta">
                  当前宽度 {panel.width}px · 默认 {PANEL_DEFAULTS[key].width}px
                </span>
                <button
                  className="tool-btn"
                  onClick={() => panel.setCollapsed(!panel.collapsed)}
                  title={panel.collapsed ? `显示${label}` : `隐藏${label}`}
                >
                  {panel.collapsed ? '已折叠（点此展开）' : '显示中（点此折叠）'}
                </button>
              </label>
            ))}
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">布局</h3>
            <div className="settings-save-row" style={{ padding: 0, border: 'none', background: 'transparent' }}>
              <button className="tool-btn primary" onClick={resetAll}>
                <RotateCcw size={14} />
                恢复默认布局
              </button>
              <span className="ocr-model-hint">
                {done || `侧边栏默认 ${PANEL_DEFAULTS.sidebar.width}px、缩略图栏 ${PANEL_DEFAULTS.pdfThumbs.width}px、批注栏 ${PANEL_DEFAULTS.annPanel.width}px`}
              </span>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">关于</h3>
            <p className="settings-hint">
              笔记工作台 Web MVP · 本地优先：文档、批注与手写数据都保存在本机，不上传服务器。
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
