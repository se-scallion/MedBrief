// ===================== 报告标题提取（OCR 形近字纠正 + 标题特征匹配）=====================
// 从 OCR 词项里抽「报告标题」（如「骨髓细胞形态检查图文报告」），用于报告类型识别与展示。
// 最初内联在 ImportFlow.startOcr 里，重新识别（reRecognize.js）也需要同一套逻辑，故抽成共享模块，
// 避免两处 OCR 纠正规则漂移导致「初次识别」与「重新识别」对标题/类型的判定不一致。

// OCR 形近字纠错（医疗报告标题专用）：tesseract 对这类字体常把「骨髓」误识为「骨通」、
// 「检验科」误识为「检验和」。在标题文本上做保守归一，避免标题/类型被乱码带偏。
const TITLE_OCR_FIX = [
  ['骨通', '骨髓'],
  ['检验和', '检验科'],
  ['骨随', '骨髓'],
  ['骨骨', '骨髓'],
]

export function correctMedicalText(s) {
  return TITLE_OCR_FIX.reduce((acc, [b, g]) => acc.split(b).join(g), s || '')
}

// 从 OCR 词项提取并纠正报告标题（兜底，不依赖外部 AI）：取含标题特征
// （医院/检验/骨髓/图文报告/细胞形态…）的词项，按 y 排序拼接后做形近字纠正。
export function extractReportTitle(items) {
  const RE = /(图文报告|检查报告|细胞形态|骨髓|骨通|血液细胞室|检验科|检验和|医院)/
  const hits = (items || [])
    .filter((it) => it.y != null && RE.test(it.text || ''))
    .sort((a, b) => a.y - b.y)
    .map((it) => correctMedicalText(it.text || ''))
  const t = hits.join('').replace(/\s+/g, '')
  return t.length >= 6 ? t : ''
}
