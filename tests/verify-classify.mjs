#!/usr/bin/env node
// 报告类型识别回归（纯函数）—— 口径搬自 MedData parseDoc.detectDocType
//
// 为什么要测：截图导入的报告抬头常常没有「报告类型」这一行，类型只能从内容推。
// 推断错了不会报错，只会让一份心脏彩超在报告库里显示成「化验单」，而资料卡按 lab 处理。
// 所以这里用**合成文本**（不含任何真实姓名/病历号）钉住分支顺序与几个已知陷阱。
//
// 用法：node tests/verify-classify.mjs
import assert from 'node:assert/strict'
import { classifyReport } from '../lib/reportClassify.mjs'

let pass = 0
const fails = []
const it = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); pass++ } catch (e) { console.log(`FAIL  ${name} → ${e.message}`); fails.push(name) }
}
const cls = (text, extra = {}) => classifyReport({ text, rows: [], kind: '', reportType: '', ...extra })

it('影像：超声心动图（含「超声」字样）→ imaging / 超声-心脏', () => {
  const r = cls('二维超声检查所见：各瓣膜形态正常；心脏测值 左房前后径31 左室前后径44；EF:左心室射血分数 68%')
  assert.equal(r.kind, 'imaging'); assert.equal(r.reportType, '超声-心脏'); assert.ok(r.inferred)
})

it('影像：截图把「超声」抬头裁掉，只剩心脏测量表 → 仍判 超声-心脏', () => {
  const r = cls('检查报告详情 检查描述 心脏测值（单位：mm）左房前后径31；左室前后径44；各瓣膜形态正常；三尖瓣反流')
  assert.equal(r.reportType, '超声-心脏')
})

it('陷阱：腹部/血管超声的 EF 页脚不得把它判成心脏（MedData parseDoc.js:190）', () => {
  assert.equal(cls('彩色多普勒超声检查报告单 肝脏 胆囊 脾脏 胰腺 EF:左心室射血分数 60%').reportType, '超声-腹部')
  assert.equal(cls('颈部血管彩超 颈动脉内中膜厚度 左心室射血分数 62%').reportType, '超声-血管')
})

it('影像：CT 部位细分；裸 CT 必须排除 HCT/ACTB/CTCF（前后紧跟字母不算 CT）', () => {
  assert.equal(cls('CT检查报告单 影像所见 双肺纹理增粗 纵隔淋巴结').reportType, 'CT-胸部')
  assert.equal(cls('CT 颅脑平扫 影像诊断 未见异常').reportType, 'CT-头颈')
  // 只有 HCT 化验值、没有 CT 检查 → 不能判成 CT
  assert.notEqual(cls('血细胞分析 HCT 30.4% ACTB 基因 CTCF 结合位点').reportType, 'CT-胸部')
})

it('病理/分子：融合基因 / 核型 / mNGS / 流式 / 骨髓 / 病理活检各自归类', () => {
  assert.equal(cls('BCR::ABL1 P210 定量 融合基因检测报告').reportType, '融合基因')
  assert.equal(cls('染色体核型分析 ISCN 2024 46,XX').reportType, '染色体核型')
  assert.equal(cls('宏基因组二代测序 mNGS 病原检测').reportType, '病原mNGS')
  assert.equal(cls('骨髓细胞形态学检查 粒红比 巨核细胞 涂片分类').reportType, '骨髓形态学（骨穿）')
  assert.equal(cls('病理诊断：淋巴结反应性增生；镜下所见；免疫组化').reportType, '病理活检')
})

it('陷阱：流式的结论模板里写着「融合基因/染色体/骨髓形态」→ 仍须判 流式免疫分型', () => {
  const r = cls('流式细胞术 免疫表型 CD45/SSC 设门；请结合融合基因、染色体核型、骨髓细胞形态学综合判断')
  assert.equal(r.reportType, '流式免疫分型', `实际 ${r.reportType}`)
})

it('陷阱：内镜取活检仍属内镜，不改判病理（顺序：内镜在病理之前）', () => {
  const r = cls('胃镜检查报告 镜下所见 胃窦取活检 2 块 病理诊断待回报')
  assert.equal(r.reportType, '内镜', `实际 ${r.reportType}`)
})

it('病历文书：标题优先；正文只出现「出院医嘱」不算出院记录', () => {
  assert.equal(cls('出院记录\n入院情况：……\n出院诊断：……').reportType, '出院记录')
  assert.equal(cls('出院诊断证明书\n主要诊断：急性B淋巴细胞白血病').reportType, '诊断证明')
})

it('化验单：有结构化行时按项目名判板块（血常规 / 凝血 / 生化 / 尿常规 / 血气）', () => {
  const panel = (names) => cls('检验报告', { rows: names.map((name) => ({ name, value: '1' })) }).reportType
  assert.equal(panel(['白细胞计数', '淋巴细胞百分比', '中性粒细胞百分比']), '血常规')
  assert.equal(panel(['凝血酶原时间', '国际标准化比值', '纤维蛋白原']), '凝血四项')
  assert.equal(panel(['丙氨酸氨基转移酶', '总蛋白', '肌酐']), '生化')
  assert.equal(panel(['尿比重', '尿胆原', '尿潜血']), '尿常规')
  assert.equal(panel(['pH=', 'pCO2', '剩余碱']), '血气')
})

it('已有类型一律不覆盖（人工填的、适配器给的都是权威）', () => {
  const r = classifyReport({ text: 'CT检查报告单 影像所见 肺部', rows: [], kind: 'imaging', reportType: 'CT-胸部' })
  assert.equal(r.inferred, false)
  assert.equal(r.reportType, 'CT-胸部')
  const r2 = classifyReport({ text: '超声心动图 心脏测值 左房', rows: [], kind: 'lab', reportType: '血常规' })
  assert.equal(r2.reportType, '血常规', '给了类型就不许被内容推翻')
  assert.equal(r2.inferred, false)
})

it('判不出来就留空：返回 unknown + inferred:false（绝不硬猜）', () => {
  const r = cls('这是一段没有任何版式特征的文字')
  assert.equal(r.kind, 'unknown')
  assert.equal(r.reportType, '')
  assert.equal(r.inferred, false)
})

it('票据识别为「票据」（导入侧按拒收处理，不进报告库）', () => {
  assert.equal(cls('增值税电子发票 发票号码 0123 价税合计 100.00').reportType, '票据')
})

it('空输入不抛错；超长文本不吃满（只判类型不解析数值）', () => {
  assert.deepEqual([cls('').kind, cls('').reportType], ['unknown', ''])
  const long = 'CT检查报告单 影像所见 ' + '纹理增粗。'.repeat(2000)
  assert.equal(cls(long).reportType, 'CT')
})

// ---------- 2026-11-15：11 份真报告实测出的误判（都是「裸关键词」惹的祸） ----------
it('骨髓形态表的「裸核型巨细胞」不得把骨穿判成染色体核型', () => {
  const t = '细胞名称 (%) 参考值\n原始巨核细胞\n幼稚巨核细胞\n颗粒型巨核细胞\n产板型巨核细胞\n裸核型巨核细胞\n分析：粒：红比例 = 2.34: 1.0'
  const r = cls(t)
  assert.equal(r.reportType, '骨髓形态学（骨穿）', `实际 ${r.reportType}`)
  // 真·染色体核型报告仍须判对
  assert.equal(cls('染色体核型分析报告单 核型：46,XX[20] 结果：未见克隆性异常').reportType, '染色体核型')
})

it('「骨髓病理检查报告」是病理活检，不是骨髓涂片形态（病理优先于骨髓）', () => {
  const t = '骨髓病理检查报告 病理号：HJ000000\n特征：造血组织容量：40%，脂肪组织容量：60%\n5.巨核细胞增生，形态及分布大致正常\n诊断意见：骨髓增生活跃，请结合病史分析'
  assert.equal(cls(t).reportType, '病理活检')
})

it('FISH 信号描述页（nuc ish / 探针）→ 融合基因，不得因「取材：骨髓」判成骨穿', () => {
  const t = '科别：血液科门诊 取材：骨髓 标本状态：合格\n图片结果：\nBCR：：ABL1\n信号描述：\n探针\t信号描述\nBCR：：ABLI（22q11.2：：9q34）\tnuc ish（ABL1,BCR） X2［500］'
  assert.equal(cls(t).reportType, '融合基因', `实际 ${cls(t).reportType}`)
})

it('PCR 基因定量报告（检测基因/结果）→ 融合基因，同样不得被「标本种类：骨髓」带偏', () => {
  const t = '血液病相关基因PCR检测报告单\n标本种类：骨髓\n检测方法：RQ-PCR\n检测基因\t结果\nBCR-ABL P190\t0\nABL\t395707\nBCR-ABL P190/ABL\t0%'
  assert.equal(cls(t).reportType, '融合基因', `实际 ${cls(t).reportType}`)
})

it('骨穿第 2 页只有「粒：红比例」+ 化学染色时仍判骨髓形态（该页通常没有标题）', () => {
  const t = '细胞名称 (%) 平均值 标准差\n原始粒细胞 1.00 0.64 ±0.01\n分析：粒：红比例 = 2.34: 1.0\nNAP积分值 NAP阳性率\nPOX PAS\nNAE NAE+NaF'
  assert.equal(cls(t).reportType, '骨髓形态学（骨穿）', `实际 ${cls(t).reportType}`)
})

it('全角冒号的 BCR：：ABL1 也要认（OCR 常见），不能只认半角', () => {
  assert.equal(cls('检测项目：FISH检测BCR：：ABL1融合基因 结论：未见异常').reportType, '融合基因')
})

console.log('\n' + '='.repeat(46))
console.log(fails.length === 0 ? `报告类型识别：${pass} 通过 / 0 失败` : `报告类型识别：${pass} 通过 / ${fails.length} 失败 → ${fails.join(', ')}`)
process.exit(fails.length ? 1 : 0)
