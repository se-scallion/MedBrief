// ===================== 顶栏分类导航 =====================
// 概览（仪表盘）/ 指标（残留病 + 血细胞详细走势合并页）/ 报告（检验 + 检查报告合并页）/
// 文书（病历文书）/ 疗程（事件与归集）。
// 「报告」一项覆盖原来的「检验」与「检查报告」两项：两页本就只差一个字、常年点错，且用户
// 找东西时记不住是化验还是检查 —— 合并进一页两 tab（详见 ReportsPage.jsx），徽章显示两库合计。
// 旧路径 /records、/archive 及其 add 子路由仍算「报告」模块（书签与 e2e 脚本直连不失效）。

import { useLocation, useNavigate } from 'react-router-dom'

const NAV = [
  { to: '/', label: '概览', end: true },
  { to: '/cbc', label: '指标' },
  { to: '/reports', label: '报告' },
  { to: '/cases', label: '文书' },
  { to: '/course', label: '疗程' },
  { to: '/cost', label: '费用' },
]

// 旧路由归并：/records（化验）、/archive（检查报告）及其 /add 子路由都高亮「报告」
const LEGACY_PREFIX = ['/records', '/archive']

export default function TopNav({ counts = { records: 0, docs: 0, events: 0, cases: 0, invoices: 0 } }) {
  const navigate = useNavigate()
  const location = useLocation()
  const countFor = (to) => {
    if (to === '/reports') return (counts.records || 0) + (counts.docs || 0)
    if (to === '/cases') return counts.cases
    if (to === '/course') return counts.events
    if (to === '/cost') return counts.invoices
    return null
  }
  // 当前选中项：用 pathname 前缀匹配（/reports/add、/records/add 都算在「报告」下）
  const path = location.pathname
  const normalized = LEGACY_PREFIX.some((p) => path.startsWith(p)) ? '/reports' : path
  const selectedKey =
    NAV.find((n) => n.to !== '/' && normalized.startsWith(n.to))?.to || (path === '/' ? '/' : '')

  return (
    <nav className="flex items-center gap-0.5 px-1 sm:px-0">
      {NAV.map((n) => {
        const c = countFor(n.to)
        const active = selectedKey === n.to
        return (
          <button
            key={n.to}
            type="button"
            onClick={() => navigate(n.to)}
            className={active ? 'topnav-link topnav-link-active' : 'topnav-link'}
          >
            {n.label}
            {c != null && c > 0 && (
              <span className="ml-1.5 rounded-full bg-slate-600 px-1.5 text-[10px] font-medium leading-tight text-white">
                {c}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
