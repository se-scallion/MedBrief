# MedBrief · 资料导入 MCP server

让**任何支持 MCP 的 AI 客户端**直接把检查单/病例塞进 MedBrief：识别 → 解析 → 入库（含查重）→ 出给门诊医生看的一页资料卡。

零依赖（不装任何 MCP SDK、不新增 npm 包），只做通路：所有能力转发给本机 `node server.mjs`（默认 `http://127.0.0.1:5174`）。识别、切块、倾斜矫正、去重、资料卡渲染**全部仍由后端负责**，这里不复制任何算法。

## 启动

```bash
cd /Users/scallion/Documents/projects/MedBrief
node server.mjs            # 先起后端（MCP 只是它的客户端）
node mcp/intake-server.mjs # stdio，由 AI 客户端拉起或手动接入
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEDBRIEF_URL` | `http://127.0.0.1:5174` | 后端地址 |
| `MEDBRIEF_TIMEOUT_MS` | `180000` | 单次请求超时（超高图切块 + 多块 OCR 需要时间） |

## 接到客户端

客户端配置（路径按本机实际填）：

```json
{
  "mcpServers": {
    "medbrief": {
      "command": "node",
      "args": ["/Users/scallion/Documents/projects/MedBrief/mcp/intake-server.mjs"],
      "env": { "MEDBRIEF_URL": "http://127.0.0.1:5174" }
    }
  }
}
```

## 工具（8 个）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `intake_ocr_image` | 图片 → 指标行 | 给 `imagePaths` 多张会**先拼接再识别**；自动倾斜矫正、超高图自动切块（`preprocessing` 里能看到 `deskewAngle` / `chunked` / `chunkValueConflicts`） |
| `intake_parse_text` | 文本 → 指标行 | 识别失败或手上有文字版报告时用 |
| `intake_stitch_images` | 多张 → 纵向拼接 | 结果落盘返回路径，喂给 `intake_ocr_image` |
| `intake_save_report` | 入库 + 查重 | 重复时 `ok:false, duplicate:true, ofReportId`，**永不静默丢弃**；确认保留时加 `force:true` |
| `intake_list_reports` | 已导入报告列表 | 只回元信息与行数，不回原文/原图 |
| `intake_get_patient` | 读病友档案 | 姓名/性别/年龄/诊断/分型/阶段/医院/主管医生/三问 |
| `intake_update_patient` | 写病友档案 | 身份证/手机号/住址**拒收**（红线） |
| `intake_get_card` | 出 A4 资料卡 | 默认脱敏；返回 `counts`/`summary` + HTML 落盘路径 |

典型链路：

```
intake_ocr_image({ imagePaths: ["/tmp/a.png", "/tmp/b.png"] })   # 手机分两张拍 → 自动拼接+识别
  → 人工/模型校对 rows（可疑行：status=unknown、valueConflict=true）
  → intake_save_report({ rows, imagePath: "/tmp/a.png", meta: { kind: "血常规", reportDate: "2026-11-01", hospital: "本部（工体南路）" } })
  → intake_get_card({ mask: true })  # 拿 htmlPath，浏览器打开即可打印/存 PDF
```

## 红线（不是疏漏，别「优化」掉）

1. **不存身份信息**：`idCard` / `phone` / `address` 一律拒收，后端也会丢弃。只有就诊人姓名是业务必需的。
2. **不编造临床事实**：识别不出就返回 `ok:false` + 空行 + 明确原因，绝不填默认值、绝不让空表冒充「这项没做」。
3. **不静默丢数据**：重复入库返回冲突详情与 `nextStep`；切块/拼接的合并行带 `suspectedStitchDuplicate` / `valueConflict` 标记，原文可回查。
4. **不给诊断建议**：资料卡只整理数值、时间、出处。

## 自检

```bash
node mcp/smoke-test.mjs [图片路径]   # 默认 /tmp/fake-lab-report.png
```

11 项断言：initialize / tools/list（含 inputSchema）/ 真图识别 / 文本解析 / 身份字段被拒 / 入库 / 重复检测 / 出卡 / 读档案 / 清理测试记录。会往 `data/reports.json` 写 1 条测试记录，**跑完按 id 精确删除**，不动别人的记录。
