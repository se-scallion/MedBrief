// ===================== 病情三维度 · 阈值与流定义（单一事实源）=====================
// 三条检测维度各自成流，**不合并、不平均**：
//   morph 形态学（骨髓涂片）  —— 骨髓原始/幼稚淋巴细胞 %，目标 ≤5%（形态学 CR，及格线）
//   fcm   流式（FCM-MRD）     —— 异常表型细胞/有核细胞 %，目标 <0.01% 或转阴
//   pcr   分子（qPCR BCR-ABL1）—— 转录本拷贝数比率 %，目标 ≤0.1%（MMR）、未检出（CMR，金牌）
//
// 阈值是**医学标准，不在界面编辑**（2026-10-19 用户拍板）：
//   - 只在本文件定义一次，界面只读展示「医学标准 · vX.Y.Z」；
//   - 改阈值 = 改代码 + 递增 THRESHOLDS_VERSION + 评审，禁止运行时/localStorage/URL 覆盖；
//   - 派生状态（pass/fail/nd）不落库，读时按当前版本重算，改标准后历史点自动重判。
//
// 注意：lod（各院检出限）与基线值属于**事实数据**，不是标准，随报告/初诊点存储，可人工修正。
// 本模块零依赖（可被 node 单测直接 import），不得引入 store / react / window。

export const THRESHOLDS_VERSION = '1.1.0' // 2026-10-19 初版 5%/0.01%/0.1%；2026-10-28 增「持续 CMR」时间刻度 CMR_STREAK

// ---- 深冻结：任何运行时改写都在严格模式下抛错（防「悄悄改了标准」）----
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v)
  }
  return Object.freeze(obj)
}

/**
 * @typedef {Object} StreamDef
 * @property {string} key        stream 标识：morph|fcm|pcr
 * @property {string} code       指标 code（实体上存这个）
 * @property {string} label      短标签（tab / 图例）
 * @property {string} sub        副标题（方法）
 * @property {string} name       指标全名（tooltip / 表格）
 * @property {string} unit       规范单位
 * @property {'linear'|'log'} scale 坐标类型
 * @property {number} floor      log 轴下限（= 未检出泳道位置）；线性轴无意义
 * @property {number} ceil       log 轴上限
 * @property {[number,number]} view 默认视窗（线性轴可缩放）
 * @property {{op:'lte'|'lt', value:number, label:string}} target 目标（达标判定）
 * @property {{from:number,to:number,label:string}} band 达标绿带
 * @property {boolean} nd       是否允许「未检出」（log 轴保留泳道）
 * @property {number} staleDays 该维数据有效期（超过则不能认证更高层级）
 * @property {string} color     该流主色（语义化，非装饰）
 */
export const STREAMS = deepFreeze({
  morph: {
    key: 'morph',
    code: 'BM_BLAST_PCT',
    label: '形态学',
    sub: '骨髓象',
    name: '骨髓原始/幼稚淋巴细胞',
    unit: '%',
    scale: 'linear',
    floor: 0,
    ceil: 100,
    view: [0, 40],
    target: { op: 'lte', value: 5, label: 'CR 5%' },
    band: { from: 0, to: 5, label: '形态学缓解' },
    nd: false,
    staleDays: 90,
    color: '#6366f1',
  },
  fcm: {
    key: 'fcm',
    code: 'FCM_MRD_PCT',
    label: '流式',
    sub: 'FCM-MRD',
    name: 'FCM-MRD',
    unit: '%',
    scale: 'log',
    floor: 1e-4, // 在 min(lod, 最小正值)/10 与 1e-4 之间取实际下限（组件里算），此处为兜底
    ceil: 100,
    view: [1e-4, 100],
    target: { op: 'lt', value: 0.01, label: 'MRD 阴性 0.01%' },
    band: { from: 0, to: 0.01, label: 'MRD 阴性' },
    nd: true,
    staleDays: 120,
    color: '#0ea5e9',
  },
  pcr: {
    key: 'pcr',
    code: 'BCR_ABL1_RATIO',
    label: '分子',
    sub: 'qPCR BCR-ABL1',
    name: 'BCR-ABL1 拷贝数比率',
    unit: '%',
    scale: 'log',
    floor: 1e-5, // CMR / 未检出泳道
    ceil: 1000,
    view: [1e-5, 1000],
    target: { op: 'lte', value: 0.1, label: 'MMR 0.1%' },
    band: { from: 0, to: 0.1, label: 'MMR' },
    nd: true,
    staleDays: 90,
    color: '#0d9488',
  },
})

export const STREAM_ORDER = Object.freeze(['morph', 'fcm', 'pcr'])

/** 目标值快照（导出用；与 STREAMS 同源，不另写字面量） */
export const TARGETS = deepFreeze(
  Object.fromEntries(STREAM_ORDER.map((k) => [k, STREAMS[k].target.value]))
)

/** 展示/认证口径：各维检出限与有效期（有效期属展示策略，不作医学标准） */
export const STALE_DAYS = deepFreeze(
  Object.fromEntries(STREAM_ORDER.map((k) => [k, STREAMS[k].staleDays]))
)

/**
 * 「持续 CMR」的时间刻度（**展示与可信度口径，不是档位**：不参与 ladderOf 升档）
 *
 * milestoneYears：进度条终点里程碑。按**日历年**比日期（闰年段 3 年 = 1096 天，不是 1095），
 *   故用 diseaseGrade.addYears 算目标日，禁止 365×n。
 * maxGapDays：连续未检出的**最大检测间隔**。超过即「脱管黑盒」，连续段必须打断、进度条归零；
 *   否则「只查过两次、相隔 1409 天」会被当成 1409 天连续缓解。
 *
 * 与 STREAMS.pcr.staleDays(90) 的分工：90 天 = 摘掉 CMR 档位（判定）；180 天 = 打断连续段（口径）。
 * 2026-10-28 用户拍板；口径变更理由见 .agents/proposals/disease-stream-trends.md 修订说明。
 */
export const CMR_STREAK = deepFreeze({
  milestoneYears: 3,
  maxGapDays: 180,
})

/** qPCR 转录本通道（P190 为本例主标志；P210/P230 只作旁路展示，不与主通道相加） */
export const ANALYTES = Object.freeze(['P190', 'P210', 'P230', 'other'])

export const SPECIMENS = deepFreeze({
  bone_marrow: '骨髓',
  peripheral_blood: '外周血',
})

/** code → stream key（实体反查；未知返回 null） */
export function streamOf(code) {
  for (const k of STREAM_ORDER) {
    if (STREAMS[k].code === code) return k
  }
  return null
}

/** 目标快照（带版本，导出/图注用） */
export function targetsSnapshot() {
  return { thresholds_version: THRESHOLDS_VERSION, targets: { ...TARGETS } }
}
