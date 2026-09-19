// 文本框（type:'text'）的样式定义：字体 / 字号 / 粗体 / 斜体 / 下划线 / 对齐 / 颜色。
//
// 这里是「唯一事实来源」：App.jsx 用它渲染屏幕上的文本框与工具栏，pdfSaver.js 用它把
// 同样的样式写进导出 PDF 的 FreeText 注释（DA + Q），两边不会各写一份而漂移。
//
// 刻意只用「CSS 字体栈 + PDF 基础 14 字体」：
//   * 不打包任何字体文件 —— 打包出来的离线 exe 里没有额外字体资源，中文靠系统字体（Windows 上的
//     雅黑/宋体/楷体）渲染，所以字体栈里把常见中文字体名都列上，取第一个存在的即可。
//   * PDF 基础 14 字体（Helvetica/Times/Courier 及其粗斜体）任何阅读器都内置，不用内嵌字体数据，
//     导出的注释文件不会因此变大。

/** @typedef {'sans'|'serif'|'kai'|'mono'} TextFontKey */

// pdf.plain/bold/italic/boldItalic = AcroForm /DR /Font 里的资源名（基础 14 字体不用内嵌数据）
export const TEXT_FONTS = [
  {
    key: 'sans',
    label: '无衬线',
    sample: 'Aa',
    css: 'system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
    pdf: { plain: 'Helv', bold: 'HeBo', italic: 'HeOb', boldItalic: 'HeBO' },
  },
  {
    key: 'serif',
    label: '宋体',
    sample: '宋',
    css: '"Songti SC", SimSun, "Noto Serif SC", "Times New Roman", serif',
    pdf: { plain: 'TiRo', bold: 'TiBo', italic: 'TiIt', boldItalic: 'TiBI' },
  },
  {
    key: 'kai',
    label: '楷体',
    sample: '楷',
    // 楷体没有对应的 PDF 基础字体，导出时按衬线（Times 家族）处理，观感最接近
    css: 'KaiTi, "Kaiti SC", STKaiti, "Songti SC", serif',
    pdf: { plain: 'TiRo', bold: 'TiBo', italic: 'TiIt', boldItalic: 'TiBI' },
  },
  {
    key: 'mono',
    label: '等宽',
    sample: 'Mo',
    css: '"Cascadia Mono", Consolas, "Courier New", "Noto Sans Mono", monospace',
    pdf: { plain: 'Cour', bold: 'CoBo', italic: 'CoIt', boldItalic: 'CoBI' },
  },
]

// 字号：Word 常用刻度（下拉里直接选，不用拖滑杆试）
export const TEXT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 64, 72]

// 行高：屏幕渲染用（PDF 里由阅读器自己排，不写进 DA）
export const TEXT_LINE_HEIGHT = 1.35

export const TEXT_ALIGNS = [
  { key: 'left', label: '左对齐' },
  { key: 'center', label: '居中' },
  { key: 'right', label: '右对齐' },
]

export const DEFAULT_TEXT_STYLE = {
  fontFamily: 'sans',
  fontSize: 16,
  bold: false,
  italic: false,
  underline: false,
  align: 'left',
  color: '#1f1f1f',
}

/** 取字体定义；未知 key 一律回落无衬线，保证老批注（没有 fontFamily 字段）也能正常渲染 */
export function textFontOf(key) {
  return TEXT_FONTS.find((f) => f.key === key) || TEXT_FONTS[0]
}

/** PDF 基础 14 字体的资源名 → PostScript 名（写进 /DR /Font 的 BaseFont） */
export const PDF_BASE14 = {
  Helv: 'Helvetica',
  HeBo: 'Helvetica-Bold',
  HeOb: 'Helvetica-Oblique',
  HeBO: 'Helvetica-BoldOblique',
  TiRo: 'Times-Roman',
  TiBo: 'Times-Bold',
  TiIt: 'Times-Italic',
  TiBI: 'Times-BoldItalic',
  Cour: 'Courier',
  CoBo: 'Courier-Bold',
  CoIt: 'Courier-Oblique',
  CoBI: 'Courier-BoldOblique',
}

/** 按 字体 + 粗体/斜体 选出 DA 里要用的资源名 */
export function pdfFontName(family, bold, italic) {
  const { pdf } = textFontOf(family)
  if (bold && italic) return pdf.boldItalic
  if (bold) return pdf.bold
  if (italic) return pdf.italic
  return pdf.plain
}

/** 反查：从 DA 里的资源名还原出 { fontFamily, bold, italic }（重新打开 PDF 时保住样式） */
export function textStyleFromPdfFontName(name) {
  for (const font of TEXT_FONTS) {
    const { pdf } = font
    if (name === pdf.plain) return { fontFamily: font.key, bold: false, italic: false }
    if (name === pdf.bold) return { fontFamily: font.key, bold: true, italic: false }
    if (name === pdf.italic) return { fontFamily: font.key, bold: false, italic: true }
    if (name === pdf.boldItalic) return { fontFamily: font.key, bold: true, italic: true }
  }
  return null
}

/** 归一化：把批注上可能缺失/非法的样式字段补成可用的一套完整样式 */
export function normalizeTextStyle(ann) {
  const src = ann || {}
  const family = textFontOf(src.fontFamily)
  const size = Number(src.fontSize)
  return {
    fontFamily: family.key,
    fontSize: Number.isFinite(size) && size > 0 ? Math.min(300, Math.max(6, size)) : DEFAULT_TEXT_STYLE.fontSize,
    bold: Boolean(src.bold),
    italic: Boolean(src.italic),
    underline: Boolean(src.underline),
    align: TEXT_ALIGNS.some((a) => a.key === src.align) ? src.align : DEFAULT_TEXT_STYLE.align,
    color: typeof src.color === 'string' && src.color ? src.color : DEFAULT_TEXT_STYLE.color,
  }
}

/** 屏幕渲染用的 CSS（scale = 查看器缩放倍数，字号和行高都要跟着缩放才「贴住」页面） */
export function textStyleToCss(ann, scale = 1) {
  const s = normalizeTextStyle(ann)
  return {
    color: s.color,
    fontFamily: textFontOf(s.fontFamily).css,
    fontSize: `${Math.max(8, Math.round(s.fontSize * scale))}px`,
    fontWeight: s.bold ? '700' : '400',
    fontStyle: s.italic ? 'italic' : 'normal',
    textDecoration: s.underline ? 'underline' : 'none',
    textAlign: s.align,
    lineHeight: String(TEXT_LINE_HEIGHT),
  }
}
