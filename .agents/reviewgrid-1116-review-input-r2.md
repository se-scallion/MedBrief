请做第 2 轮独立审核。这是 v0.2（已落实 r1 三条 P0 + 两条实质结论 + 两条附问）：
- P0-1 保存按钮恒灰 → 传 date 镜像 meta.reportDate、onSave 只回写 rows、上方加说明行（不改 MedData 组件）
- P0-2 复制反馈无料 → recognize() 成功后自行 emitTrace(item.id, snapshot)
- P0-3 0 行批量回退解析 → targets 加 status!=='failed' && text.trim()，saveReport 带 meta.textOnly=true
- 「rows>0 才挂＝半个组件」→ 改为 0 行也整份挂、删 Empty
- 「重新识别必然撞查重」→ D3/D4 提前写明 + 沿用现有「仍要导入」出口
- F7 显式 WEB_OUT + 硬刷新；e2e 是 API 驱动，UI 断言另用 Playwright 起副本服务

请核：① 上一轮 3 条 P0 / 2 条实质结论 / 2 条附问是否全部闭环；② v0.2 有没有新引入的自相矛盾或执行顺序风险；③ 特别复核下面 5 点。最后给总判三档之一 + 按执行顺序的必改清单。中文、简洁，指到编号与可复跑证据。

特别复核：
1. `date = meta.reportDate || meta.sampledAt` 让保存按钮可点后，DataGrid 内部还有没有**别的** `date` 消费点（如 rawGrid/feedback 的 collectedAt、buildFeedback 的 date 参数）会被这个「报告日期当采集日期」污染？与 F3「单一 state」是否真不冲突？
2. `emitTrace(item.id, snapshot)` 的 `rawGrid` 从 `body.blocks` 归位是否可行？MedBrief `/api/intake/ocr` 的响应到底有没有 blocks（现有 IntakePage.jsx 的 patchItem 只取了 text/rows/engine），若没有，snapshot 该放什么才不算「假造 trace」？
3. `meta.textOnly=true` 加在 **saveReport 的 payload** 里会不会影响非 0 行报告（现在 payload 的 meta 是整个 item.meta 透传）？是只在 0 行分支加，还是无条件加？两种的副作用各是什么？
4. D4「重新识别重置为新的待入库内容」后，`item.dataUrl` 仍是原图，`sha256` 不变 → `dup`。计划说「沿用现有仍要导入出口」，但**批量导入 `silent:true` 不弹确认框**（IntakePage.jsx:357-362 直接跳过），用户重导时在批量路径仍会被静默跳过。这个断点怎么补？
5. 0 行也挂 DataGrid 后，DataGrid 的「一键修正/智能补项/复制反馈」在 0 点时的行为（有没有除以 0、空数组崩、或按钮亮但无效果）需要加哪些断言？

计划：/Users/scallion/Documents/projects/MedBrief/.agents/reviewgrid-1116-plan.md（v0.2）
r1：同目录 reviewgrid-1116-review-r1.md
判词写进 /Users/scallion/Documents/projects/MedBrief/.agents/reviewgrid-1116-review-r2.md（只写这一个文件，不改计划、不改生产代码），回我「已写 r2」+ 一句总判。
