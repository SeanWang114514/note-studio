import { useEffect, useState } from 'react'
import { HardDrive, LayoutPanelLeft, RotateCcw, Settings, Trash2, X } from 'lucide-react'
import { PANEL_DEFAULTS, resetPanel, usePanel } from '../lib/panelLayout.js'
import { clearFileCache, fileCacheStats } from '../lib/fileCache.js'
import { formatBytes } from '../lib/FileProcessor.js'

/**
 * 设置弹窗：窗口与面板布局 + 本地缓存管理。
 * （语音识别模型 / 手写识别模型相关配置已按需求整体移除。）
 */
export default function SettingsModal({ open, onClose, notify }) {
  const sidebar = usePanel('sidebar')
  const thumbs = usePanel('pdfThumbs')
  const annPanel = usePanel('annPanel')
  const [done, setDone] = useState('')
  const [cache, setCache] = useState({ count: 0, bytes: 0 })
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (!open) return
    setDone('')
    fileCacheStats()
      .then(setCache)
      .catch(() => setCache({ count: 0, bytes: 0 }))
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

  const clearCache = async () => {
    setClearing(true)
    try {
      const { removed, bytes } = await clearFileCache()
      setCache({ count: 0, bytes: 0 })
      flash(
        removed
          ? `已清除本地缓存：${removed} 个文件，释放 ${formatBytes(bytes)}`
          : '本地缓存本来就是空的',
      )
    } catch (err) {
      notify?.(`清除缓存失败：${err?.message || err}`, 'error')
    } finally {
      setClearing(false)
    }
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
            <h3 className="settings-section-title">本地缓存</h3>
            <p className="settings-hint">
              打开过的文件会在本机存一份内容副本，供「最近文件」直接重开
              （安卓 APK 里系统不给文件句柄，只能靠这份缓存）。
              批注、手写等数据是另一套存储，清除缓存不会动它们。
            </p>
            {/* 用 div 而不是 label：label 里套 button 会把按钮的可访问名和点击
                都跟整行文字绑在一起（.settings-panel-row 是按 class 定样式的） */}
            <div className="settings-panel-row">
              <span className="ocr-model-label">
                <HardDrive size={13} />
                文件内容缓存
              </span>
              <span className="settings-panel-meta">
                {cache.count > 0
                  ? `${cache.count} 个文件 · ${formatBytes(cache.bytes)}`
                  : '暂无缓存'}
              </span>
              <button
                className="tool-btn"
                onClick={clearCache}
                disabled={clearing || cache.count === 0}
                title="清除全部文件内容缓存（不影响批注与已保存到下载目录的文件）"
              >
                <Trash2 size={14} />
                {clearing ? '清除中…' : '清除缓存'}
              </button>
            </div>
            <p className="ocr-model-hint">
              缓存上限：单文件 64 MB、合计 256 MB，超出后自动淘汰最久未用的文件。
            </p>
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
