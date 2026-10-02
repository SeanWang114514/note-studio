// 必须最先求值：补齐旧版 WebView 缺失的 Promise.withResolvers 等 API
// （pdfjs 4.x 依赖它，缺了就是「PDF 打开失败：Promise.withResolvers is not a function」）。
// 放在第一条 import，保证在 App → pdfEngine → pdfjs 求值之前打上补丁。
import './lib/polyfills.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { tagMobileShell } from './lib/mobile.js'
import './styles.css'
// Apple HIG 外观层：必须在 styles.css 之后加载才能覆盖既有外观
import './hig.css'

// 标记当前环境是否按移动端触屏交互（<html data-mobile="1">），CSS 与面板默认值都读它。
// 判定在 lib/mobile.js：原生 APK / 触屏+coarse 指针+窄屏。
tagMobileShell()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
