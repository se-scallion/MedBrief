// 报告导入 · 适配器注册表
//
// 设计（D9 排雷后的最小结构）：**一种报告版式 = 一个适配器文件**，CLI 里不写任何 if-else。
// 新增一种报告形式时只做三件事：
//   1. 在 tools/report-adapters/ 新建 <form>.mjs，默认导出 { id, title, match(text), parse({ lines, text }) }；
//   2. 追加到下面的 ADAPTERS 数组（顺序 = 匹配优先级，越具体越靠前）；
//   3. 在 tests/verify-import-report.mjs 里加一条只读断言（用手上那份报告的真实文本）。
//
// 约定（红线，不随适配器变化）：
//   - parse() 只能照抄报告原文的数字与名称，**不许推断**（不把「异常细胞%」改写成「原始细胞%」）；
//   - 报告没给参考区间就不许编参考区间，也不许判偏高/偏低（status 一律 'unknown'）；
//   - 每个指标行必须带 rawSnippet（原文片段），供人核对与回查；
//   - 读不到就是空串/不产出该行，禁止填默认值。

import flowImmunophenotype from './flow-immunophenotype.mjs'
import karyotype from './karyotype.mjs'
import labPanel from './lab-panel.mjs'
import { stripWatermarkTokens, collectSuspects, parseHeadFields, pickReportDate, assessLabRows } from './shared.mjs'

export { stripWatermarkTokens, collectSuspects, parseHeadFields, pickReportDate, assessLabRows }

// 顺序 = 匹配优先级：越具体的版式越靠前，lab-panel 必须最后（它是恒命中的兜底）
export const ADAPTERS = [flowImmunophenotype, karyotype, labPanel]


/** 依次问每个适配器；第一个 match 命中者胜出。都不命中返回 null（CLI 报「需要新增适配器」）。 */
export function pickAdapter(text = '') {
  const cleaned = stripWatermarkTokens(String(text).split(/\r?\n/)).join('\n')
  for (const a of ADAPTERS) {
    const score = a.match(cleaned)
    if (score > 0) return { adapter: a, score, cleaned }
  }
  return null
}



export default { ADAPTERS, pickAdapter, stripWatermarkTokens, collectSuspects }
