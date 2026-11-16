请对《② 识别与校对整份挂 DataGrid + 导入状态机修复》v0.1 做独立 AI 审核（第 1 轮）。中文、简洁、按 P0/P1/P2 给必改清单（按执行顺序），每条指到计划里的编号（A/B/C/D 或候选号）与可复跑证据；最后给总判三档之一。不要重写计划、不要编码。

计划全文：/Users/scallion/Documents/projects/MedBrief/.agents/reviewgrid-1116-plan.md

背景：用户 2026-11-16 两次点名——①「整个组件搬过来」指 MedData DataGrid 应整体用于「资料录入→②识别与校对」，此前只挂了报告库编辑弹窗；② 识别成功并导入后再点「一键导入」永远提示「没有可入库的条目」，勾选条目/重新识别都无效。作者上一轮误判为「别再出计划」想直接改，被用户问「你过计划流程了吗？」拦住；本轮按融合后的 SOP（§5 四段 + §8 独立审核 3 轮）重来。

请特别攻击这 6 点：
1. D2 把 DataGrid 整份挂进 ② 校对区时，`onSave`（DataGrid.jsx:1401 自带「保存到本地数据库」）与 `onReset`、日期输入、reportType 下拉会不会与 IntakePage 现有 meta 表单形成**双写/两个真相**？计划 F10 的「onSave 只回写 item.rows」够不够？
2. F11 用 `traceId=item.id` 让「复制反馈」可用是否成立？DataGrid.jsx:966 的 `readTraceLocal(traceId)` 在 MedBrief 的 shim 下会不会读不到 trace 而让按钮仍灰、或点开后 rawGrid 为空？（注意 ReportsPanel.jsx:557 现在传 traceId=""）
3. D3 的 4 态分类是否覆盖了用户实测路径：**已入库(saved) → 再点一键导入 → 勾选 → 点重新识别 → 仍同样提示**。特别是「重新识别」按 D4 重置 `saved` 后，`item.status`/`rows`/`baselineRows`/`text` 与 `recognize()` 现有 patchItem 是否会互相覆盖？
4. ⑦「0 行但有 text 的全文型报告纳入批量 targets」会不会把**未识别成功**的空文本项也放进来？与 `/api/intake/reports` 的入库载荷、`rowsForType` 门控是否冲突？
5. C 段 ⑧「录入面不写 corrections 表」砍得对不对？用户原话「我需要记录操作用于优化反馈」是否要求录入阶段也记录？
6. D2 说「rows.length>0 才挂 DataGrid」是否又变成「半个组件」？用户要的是「整个组件搬过来」，0 行时的 Empty 分支会不会被判定为没搬全（与 R9/F4 冲突）？

另请核：F7「改 web/** 不必重启 5174」是否成立（长驻进程加载的是静态产物）；D5 的 e2e 用副本库是否真能不碰真实库（现有 tools/e2e-real-pdf.mjs 是 5175+副本库机制吗）。

把判词写进 /Users/scallion/Documents/projects/MedBrief/.agents/reviewgrid-1116-review-r1.md（只写这一个文件，不改计划、不改任何生产代码），回我一句「已写 r1」+ 一句话总判。
