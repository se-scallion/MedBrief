请对《报告库列表 UI 整改》v0.1 做独立 AI 审核（第 1 轮）。中文、简洁、按 P0/P1/P2 给必改清单（按执行顺序），每条指到计划编号与可复跑证据；最后给总判三档之一。不要重写计划、不要编码。

计划全文：/Users/scallion/Documents/projects/MedBrief/.agents/reportlib-ui-1116-plan.md

背景：用户 2026-11-16 点名 5 项——移动端空间/缩进/超长；只显示重要信息（医院和指标项不关心，关心检查类型）；操作按钮改图标+大小不要文字；按天 section 列表、头部只写一次日期、日期组件要详细选型；删除隐藏/小图标/右上角「管理」按钮才显示。该计划与已终审的 reviewgrid-1116-plan.md v0.6 是两条线，v0.6 第 1 段刚把 ReportsPanel.jsx 改为 import points.js（同文件错峰）。

请特别攻击 6 点：
1. D1 选 antd `List`+`Badge`+`Divider` 做「按天分组」，但用户要的是「每一天单独一个小模块（section）」——List 的默认 `List.Item` 是扁平行，分组头怎么落才不变成「又一张表」？Collapse 被砍的理由够不够（用户没说要折叠，但也没禁止）？
2. R3/F4「日期未识别」单独一组：真实库里 `reportDate=''` 但 `createdAt` 有值，按天分组时这些记录会不会因为没有日期键而被 `dayjs` 格式化成 Invalid Date / 1970-01-01？给出可复跑的断言口径。
3. 桌面「操作列文字按钮换图标」是否算超出用户范围（用户说的是移动端/空间）？与 R9 的「桌面一行不动」⑥ 是否自相矛盾？
4. 删除「管理」开关与 `Popconfirm` 的组合：管理态下每行删除图标仍要二次确认吗？回收站 tab 的「恢复/彻底删除」不受开关影响，会不会让用户找不到恢复入口（R5）？
5. 只显示检查类型后，`reportTypeInferred` 的「推断」Tag、全文型报告「全文」标记、`hasOriginal=false` 的「无原件」提示，在窄屏次行会不会又挤成一团？超长 `reportType`（如「骨髓形态学（骨穿）」）ellipsis 后 Tooltip 是否可点？
6. R4/F6：换 List 后列头三态排序（reportSort.js 的 `nextSort`）在 xs 用 Segmented 替代，是否保住「缺值恒末位 + 中文 localeCompare」？搜索框现有全字段匹配（含医院）在「不显示医院」后是否要改口径？

另核：D4 说「CSS 走 APP_MOBILE_CSS 同款注入」，但 App.jsx 的注入是**全局挂载期**、ReportsPanel 是页面组件——新样式该放全局还是页面级 useEffect（卸载即移除）？与 577c07a 刚加的 `#mb-report-drawer-mobile` 会不会冲突。

判词写进 /Users/scallion/Documents/projects/MedBrief/.agents/reportlib-ui-1116-review-r1.md（只写这一个文件，不改计划、不改任何生产代码），回我「已写 r1」+ 一句总判。
