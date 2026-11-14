// MedBrief ⇄ MedData 指标码别名表（2026-11-14）
//
// 为什么需要：两个仓各维护一份指标码表 —— MedBrief 的 ANALYTE_CATALOG（lib/reportIntake.mjs）
// 与 MedData 的 meddata/src/data/dictionary.js。实测两边码总数 141 vs 161、交集仅 52，
// 其中 **9 组是「同名不同码」**（同一个检验项目，两边写法不一样）。
// 不归一的话，同一条指标进 MedData 后会落到另一条趋势曲线上，跨系统趋势会断成两条。
//
// 原则：
//   1. **本文件是零依赖纯 ESM**（不 import 任何 node: 模块、不读文件），前端 Vite 可直接引入；
//   2. 只登记「已实证的同名不同码」，不猜；新增一条要给出两边字典里的出处；
//   3. MedBrief 内部一律用自己的码（ANALYTE_CATALOG 仍是唯一登记处）；
//      只有「往 MedData 写/比对」的那一刻才用 toMedDataCode()。

/** MedBrief 码 → MedData 码（9 组，均为同名不同码）。 */
export const MEDBRIEF_TO_MEDDATA = Object.freeze({
  TP: 'TP_PROTEIN',      // 总蛋白
  GLOB: 'GLO',           // 球蛋白
  FERRITIN: 'FERR',      // 铁蛋白
  VB12: 'VIT_B12',       // 维生素B12
  VITC: 'UVC',           // 维生素C
  U_SG: 'USG',           // 尿比重
  U_UBG: 'URO',          // 尿胆原
  U_NIT: 'UNIT',         // 亚硝酸盐
  U_PH: 'UPH',           // 尿 pH
})

/** MedData 码 → MedBrief 码（上表反向，构建时自动生成，避免手抄漂移）。 */
export const MEDDATA_TO_MEDBRIEF = Object.freeze(
  Object.fromEntries(Object.entries(MEDBRIEF_TO_MEDDATA).map(([mine, theirs]) => [theirs, mine])),
)

/** 同一个码在两仓之间可能有 3 种状态：直通 / 别名 / 无对应。 */
export const CODE_ALIAS_STATUS = Object.freeze({ SAME: 'same', ALIASED: 'aliased', UNMAPPED: 'unmapped' })

/** MedBrief 码 → MedData 码。未登记的原样返回（大多数码两边是同名的）。 */
export function toMedDataCode(code) {
  if (!code) return code
  return MEDBRIEF_TO_MEDDATA[code] || code
}

/** MedData 码 → MedBrief 码。未登记的原样返回。 */
export function toMedBriefCode(code) {
  if (!code) return code
  return MEDDATA_TO_MEDBRIEF[code] || code
}

/** 查一个 MedBrief 码在 MedData 侧是什么状态（给对账/体检用，不参与渲染）。 */
export function aliasStatus(medbriefCode) {
  if (!medbriefCode) return CODE_ALIAS_STATUS.UNMAPPED
  return MEDBRIEF_TO_MEDDATA[medbriefCode] ? CODE_ALIAS_STATUS.ALIASED : CODE_ALIAS_STATUS.SAME
}

/** 批量转换（保持顺序，忽略空值）。 */
export function toMedDataCodes(codes = []) {
  return codes.map(toMedDataCode)
}
