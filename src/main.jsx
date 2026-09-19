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
