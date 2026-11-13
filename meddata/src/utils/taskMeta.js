// ===================== AI 任务展示口径（任务中心 / 导入页共用）=====================
// 为什么单独抽一层：任务中心列表、结果弹层、导入页「来自任务」横幅三处都要显示
// 「短码 / 入口 / 模式」，各写一份必然漂移（同一条任务在两处显示成不同标签，用户更没法对应）。
// 纯常量 + 纯函数，不引用浏览器 API，可直接被单测脚本引用。

// 读图模式
export const MODE_CN = { doc: '读原图', 'doc-text': '文本整理', lab: '化验转录' }

// 任务是从哪个入口发起的（2026-10-25 起服务端落盘 origin）。
// 为什么必须记：两个入口的任务 id 格式完全一样（docread-<ts>-<rand>），
// 不加这个字段，事后无法判断某次任务到底是「导入页 AI 识别」还是「详情页 AI 重读」。
// lab（检验报告导入页的 AI 精读，mode:'lab'）/ rerec（已归档化验记录换引擎重识别）补于 2026-11-03：
// 这两条线原来都不带 origin，任务中心一律显示「早期任务」——新建的任务被标成"早期"是自相矛盾的。
export const ORIGIN_CN = {
  import: '检查报告导入',
  lab: '检验报告导入',
  rerec: '记录重识别',
  case: '病历文书导入',
  reread: '详情页重读',
}

export const originLabel = (origin) => ORIGIN_CN[origin] || '早期任务'

// 「继续导入」该回哪个窗口：病历文书回 /cases/add，化验转录回检验报告导入页，其余回检查报告导入页。
// 为什么不统一回一个页：三类产物落不同的归档表（category=case/lab/exam），
// 回到错误页面等于白填一屏——**化验转录任务的产物是 rows（指标表格），
// 检查报告页只认 title/findings/conclusion，落过去必然是一屏空白**（2026-10-28 #ruyd81 现场）。
export const resumePath = (task) => {
  const id = encodeURIComponent(String((task && task.id) || ''))
  if (!task) return `/reports/add?flow=doc&task=${id}`
  if (task.origin === 'case') return `/cases/add?task=${id}`
  // mode 由服务端任务列表/详情给出（lab = 化验转录，见 MODE_CN）
  if (task.mode === 'lab') return `/reports/add?flow=lab&task=${id}`
  return `/reports/add?flow=doc&task=${id}`
}

// 任务短码：取 id 末段（docread-1792456882783-9nkek → #9nkek）。
// 人眼核对用这个，而不是 64 位 sha —— 十六进制肉眼比对必错（机器匹配仍走 sha256）。
export const shortId = (id) => {
  const s = String(id || '')
  if (!s) return ''
  const tail = s.split('-').filter(Boolean).pop() || s
  return `#${tail.slice(-6)}`
}

// 任务提交时间（MM-DD HH:mm），任务中心与导入页横幅同一口径
export const fmtStamp = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ===================== 测试任务识别 =====================
// 为什么必须有：回归脚本（scripts/verify-doc.mjs:104）用 `docverify-<ts>-<rand>` 前缀提交，
// 且上传文件名叫用例目录里的 source.txt / source.jpg。实测 logs 里 134 条测试任务 vs 27 条真实任务，
// 结果就是「任务中心满屏 source.txt」，用户会以为是自己传了个 txt（2026-10-27 用户当场质疑「我不可能提交 source.txt」）。
// 判据两条：① 服务端 origin==='regress'（新脚本会带）；② id 前缀（老脚本没带 origin，只能看前缀）。
// 名字不能当判据 —— 用户真实上传的文件名本来就长这样，靠名字会误伤。
const TEST_ID_PREFIXES = ['docverify-', 'smoke', 'realtest', 'e2e-', 'probe', 'selftest']

export const isTestTask = (t) => {
  if (!t) return false
  if (t.origin === 'regress') return true
  const id = String(t.id || '')
  return TEST_ID_PREFIXES.some((p) => id.startsWith(p))
}
