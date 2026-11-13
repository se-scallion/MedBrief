/**
 * ORC 优化运行时补丁（数据层）—— 「按生效方式拆分 ORC 优化」的 A 半落点。
 *
 * 设计（docs/新类型报告自动触发ORC优化-design-v1.md 附录 J）：
 *   A 半 = 表驱动增量（字段 / 别名 / keyFields / 段落名 / 定义码）：写本文件即生效，
 *          不改逻辑、不需要工作树隔离、回滚 = 清空数组或跑 rollback。
 *   B 半 = 解析 / 归一逻辑改动：必须改源码 + 全量门禁 + recog tag（不在本文件）。
 *
 * 铁律：
 *  1. 本文件只放数据，禁止放函数 / 条件分支。
 *  2. 沉淀纪律：每次 recog-vX.Y.Z 存档前，把生效中的补丁合并回
 *     dictionary.js / parseDoc.js / ocr.js 的静态表并清空本数组（save-recog-version.mjs 会警告）。
 *  3. 失败绝不传染识别：应用处 try/catch 兜底，写坏本文件 = 退回"无补丁"跑。
 *  4. 原子写：一律经 scripts/patch-apply.mjs（tmp → 校验 → rename），不要手改。
 *
 * ⚠ 本文件由 scripts/patch-apply.mjs 生成，手工编辑请同步 PATCH_REVISION；
 *   多人/多会话并发时请走脚本（带 revision 乐观锁，防止互相覆盖）。
 *
 * 补丁项形状（每项都可省略，全量见 src/data/applyPatches.js）：
 * {
 *   id: 'opt-20261029-4f7a',                            // 必填：来源工单 / 版本
 *   note: '骨髓形态学：补 3 个细胞系字段',                 // 可选：人读说明
 *   fields:      [{ code, name, unit, ref, group }],     // 新增字段（源码同 code 则跳过 = 源码优先）
 *   aliases:     { CODE: ['别名1', '别名2'] },            // 追加别名（去重）
 *   keyFields:   { REPORT_TYPE: ['CODE'] },              // 追加报告类型关键字段
 *   sections:    { findings: ['镜下所见'], conclusion: [], exclude: [] },
 *   definingCodes: ['BNP'],                              // 类型定义码（防双栏反推改类型）
 * }
 */

/** 修订号：每次落盘 +1。用于并发写的乐观锁（写前比对，不一致即中止）。 */
export const PATCH_REVISION = 5

/** 生效中的补丁列表。沉淀完成即清空为 []。 */
export const PATCHES = []
