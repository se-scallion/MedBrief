这是对 r3 终判「只准哪几条」的复审输入（不是作者自行加轮次：r3 未给「可以开工」，按 §8.5 必须把 ④⑦ 的两条口径裁到终态后整份重送）。

v0.4 已把 r3 的两条翻车点裁到终态：
- A（重导）：**砍掉 forceReimport/force:true**。已入库条目「重新识别」→ 生成待校对副本（新 id、不写库、带 sourceReportId）→ 用户明确二选一：「更新原报告」走新增但很薄的 `PUT /reports/:id` + `rowsReplace`（原地更新、不 push 第二条、from/to 进 patchLog）／「另存为新报告」沿用现有单张确认且文案写明「库里会有两份同源报告」。批量路径无自动强导。
- B（智能补项）：fromPoints 保留 inferred 标记；saveReport 入库前过滤空 value 行并报「N 行无值未入库」；新增断言「智能补项后入库仍 0 行」「更新原报告后 reports.length 不变」「rowsReplace from/to 全进 patchLog」。
- r3 的 6 条 P1/P2：实施拆三段、报告库 date 对齐 sampledAt、D2 reportedDate/reportType 写重复合并、显式 WEB_OUT+硬刷新、emitTrace localStorage 失败可见、副本库+Playwright 断言 —— 全部已写进 v0.4。
- v0.2 历史段里「forceReimport+force:true」的旧表述已标注「已被 r3 A 推翻」，不再与正文冲突。

请只回答：① A/B 两条口径是否真的闭环（特别核：新增 `PUT /reports/:id` + rowsReplace 有没有绕开 `lib/reportStore.mjs` 的原子写与 `{version,reports,trashed,audit}` 四字段、有没有破坏 patchLog 既有语义；空 value 过滤会不会把「阴性/未检出/定性结果」误删）；② v0.4 有没有新自相矛盾；③ 现在是否可以给「可以开工」。中文、简洁，给终判三档之一；若仍有 P0 请指到编号。

计划：/Users/scallion/Documents/projects/MedBrief/.agents/reviewgrid-1116-plan.md（v0.4）
r1/r2/r3：同目录 reviewgrid-1116-review-r1.md / -r2.md / -r3.md
判词写进 /Users/scallion/Documents/projects/MedBrief/.agents/reviewgrid-1116-review-r4.md（只写这一个文件，不改计划、不改生产代码），回我「已写 r4」+ 一句总判。
