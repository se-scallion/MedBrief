【任务】用户 2026-11-16 13:51 要求：直接走 AI 审核流，由**审核 AI 出整改方案**（不是由作者先改再让你核）。请把截图 + 情况核完，出一份可执行的整改方案（含 CSS 具体写法、对齐判据、断言清单、桌面零回归判据）。中文、简洁、指到行号与可复跑证据。不改任何生产代码、不写计划文档以外的文件。

## 用户原话
「还是那个弹窗，本来移动端空间就不够用，你还留那么多Padding，ant-modal-container ant-modal-body，这两个样式类都有Padding。版面也对不齐了。你直接走AI审核流，把截图和情况发给他，让审核AI出整改方案。」

## 必看材料（只读）
1. 截图（真浏览器 375×812，deviceScaleFactor 2）：
   - /Users/scallion/Documents/projects/.agents/edit-modal-375-before.png（首屏）
   - /Users/scallion/Documents/projects/MedBrief/.agents/review-assets/edit-modal-375-body-full.png（body 全高）
2. 当前窄屏 CSS：/Users/scallion/Documents/projects/MedBrief/web/src/pages/intake/ReportsPanel.jsx:104-121（REPORT_EDIT_MODAL_MOBILE_CSS）
3. 弹窗 JSX：同文件 :632-690（className=mb-edit-modal、style.top=isXs?8:100、width=900、顶部 rb-edit-top-save、说明文字、rb-edit-grid-wrap + DataGrid）
4. 三个页面级 style 的 useEffect：同文件 :165-185 一带（day / drawer / edit-modal 各独立 id）
5. 现有断言：tests/verify-edit-modal-375.mjs（10 条）、tests/verify-report-lib-ui.mjs（style id 唯一断言）

## 实测几何（作者只读复跑，2026-11-16 13:52，5174 head=bd34b14）
- .mb-edit-modal.ant-modal：width=359（css 100vw-16）、y=8、h=796、padding 0
- **.ant-modal-container：padding `20px 24px`**（这是 antd 默认值，作者上一轮没覆盖）
- .ant-modal-header：padding `10px 12px`、x=32 w=311
- **.ant-modal-body：padding `8px 12px`、x=32 w=311、scrollW=796 / clientW=311（overflowX:auto）**
- .ant-modal-footer：padding `8px 12px`
- .rb-edit-grid-wrap：x=44 w=287 scrollW=784 / clientW=287
- body 的直接子节点 ant-space：x=44 w=287
- de=375；wrap scrollHeight=812==clientHeight（上一轮已修「整页下滑」）
- 1440 桌面：y=100 h=726、顶部保存按钮仍显示、body 无内部滚动 → **桌面必须保持零回归**

## 作者承认的问题（不狡辩）
1. container 的 `20px 24px` 与 body 的 `8px 12px` **叠加**：左右各 36px，正文可用宽从 359 掉到 287；上下也吃掉约 56px 首屏。用户说得对，移动端空间本就不够。
2. `overflowX:auto` 是作者为 760px DataGrid 网格加的「body 自己滚」，但网格 `scrollW=784` 把 body 变成**横向+纵向双滚动**，版面左右对不齐（header/footer 文字在 x=32+12，网格内容在 x=44 内又滚）。
3. 上一轮只解决了「顶部空余/整页下滑」，没解决「padding 叠加 + 对齐」，属于没做完。

## 请审核 AI 特别回答（方案必须逐条覆盖）
1. container 与 body 的 padding 该**各留多少 / 谁归零 / 用哪一层做唯一水平栅格**，才能让 header/body/footer 的文字左边界对齐、且正文宽度最大？给出具体 CSS（含 !important 作用域必须只限 `.mb-edit-modal`，≤575px）。
2. DataGrid 的 760px 网格在 375 下该怎么放：是继续 body 横向滚（会破坏对齐），还是给 `rb-edit-grid-wrap` 单独 `overflow-x:auto` + body 禁横滚？给出「单一横向滚动容器」的写法，并要求 body 的 `scrollWidth <= clientWidth`。
3. 顶部说明行（当前一行 + Tooltip）、医院输入行、DataGrid 内部 `card p-4` 等 padding 是否也要收？列一份「可删/可收/必须留」清单，别只改两个类又留一圈内边距。
4. 三段页面级 style（day/drawer/edit-modal）之间会不会互相覆盖？整改方案要不要动 `tests/verify-report-lib-ui.mjs` 的「id 唯一」断言？
5. 给出**验收断言清单**（几何数字判据，不写死快照）：贴顶、整页不需下滑、body 无横向溢出、header/body/footer 左边界对齐、正文可用宽 ≥ 某值、footer 常驻、桌面 1440 零回归、三段 style 并存且 id 唯一。
6. 明确「方案」与「编码」的边界：本次只出方案，作者拿到判词后才改（用户要求的是让审核 AI 出整改方案）。

把判词写进 /Users/scallion/Documents/projects/MedBrief/.agents/edit-modal-1116-review-r1.md（只写这一个文件，不改计划、不改任何生产代码、不写测试）。回我一句「已写 r1」+ 一句话总判（方案是否可直接执行 / 还需补什么）。
