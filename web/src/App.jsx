import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  App as AntApp,
  Badge,
  Button,
  Drawer,
  Layout,
  Menu,
  Space,
  Tag,
  Typography,
} from 'antd'
import MonitorPage from './pages/MonitorPage.jsx'
import BookingPage from './pages/BookingPage.jsx'
import BriefPage from './pages/BriefPage.jsx'
import SessionPage from './pages/SessionPage.jsx'
import IntakePage from './pages/IntakePage.jsx'
import ReportsPanel from './pages/intake/ReportsPanel.jsx'
import CardPage from './pages/CardPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import AccountAdminPage from './pages/AccountAdminPage.jsx'
import { jfetch, jget } from './api.js'

const { Header, Content, Footer, Sider } = Layout
const { Text } = Typography

// W10（2026-11-14，用户批准「② 窄屏隐藏 Sider + 顶部菜单下拉」）：
// 手机端 ≤575px 隐藏被压成 56px / 单字竖排的 Sider，顶栏换成汉堡按钮 + Drawer 里的同一份分组菜单。
// 这段 CSS 只在 App 挂载期注入 head、卸载即移除；媒体查询限定 ≤575px，桌面 ≥992 一条都不匹配。
// 顶栏规则也归这里（W10 更正 3：单一 owner，CardPage 只留卡片专属规则）。
// 探针实测：与 CardPage 的 #mb-card-mobile 共存无冲突；7 页 de 全 375；992/1440 零影响。
// 为什么连内容区一起收敛：375 下除资料卡外 6 页原本 de=415/435（各页自身宽表/长文本），
// 隐藏 Sider 让正文 319→375 后仍需通用窄屏规则兜住，才不会因导航改造变差。
const APP_MOBILE_CSS = `
@media (max-width: 575px) {
  .ant-layout-sider { display: none !important; }
  .ant-layout-header { flex-wrap: nowrap !important; height: auto; padding-inline: 12px !important; padding-block: 6px; }
  /* 汉堡按钮是 Header 直接子元素（见 JSX）：桌面 display:none，窄屏绝对定位在左侧。
     左 Space 现在只剩两项：MedBrief（第 1 项）+ 副标题（第 2 项）—— 2026-11-14 用户要求
     去掉「北京朝阳医院 · 血液内科 · 主鸿鹄」Tag（项目面向多病人多医院，不为单一医生定制）。
     所以只隐藏第 2 项（副标题），标题保持可见。
     padding-inline 必须 !important：Header 有内联 style paddingInline:20，层叠最高。 */
  .ant-layout-header { position: relative; }
  .mb-header-left > .ant-space-item:nth-child(2) { display: none !important; }
  .mb-header-left { margin-left: 36px; }
  .mb-nav-trigger { display: inline-flex !important; }
  /* 账号系统：窄屏隐藏手机号文字，压缩右侧按钮，防止 header 变高打断 375 布局断言 */
  .mb-user-phone { display: none !important; }
  .mb-header-right { gap: 4px !important; }
  .mb-logout, .mb-log-btn { padding-inline: 6px !important; font-size: 12px !important; }
  .ant-layout-content { padding: 12px !important; }
  .ant-card-head { flex-wrap: wrap; height: auto; }
  .ant-card-head .ant-card-extra { max-width: 100%; margin-inline-start: 0; overflow: hidden; }
  .ant-table table { table-layout: fixed; }
  .ant-table th, .ant-table td { word-break: break-word; }
  .ant-table-wrapper, .ant-card, .ant-space, .ant-form-item, .ant-row, .ant-col, .ant-segmented, .ant-input-group, .ant-tabs { max-width: 100%; }
  img, iframe, video, canvas { max-width: 100%; }
}
/* 桌面默认不显示手机菜单入口；放 Header 直接子元素而非左 Space 内，
   避免 antd Space 给 display:none 的 item 仍预留 12px gap（桌面 Tag 会整体右移 12px）。 */
.mb-nav-trigger { display: none; position: absolute; left: 12px; top: 50%; transform: translateY(-50%); }
`

// ---------- 全局事件日志（各 tab 共用，替代旧页面的 appendLog） ----------
const LogContext = createContext({ logs: [], pushLog: () => {}, clearLogs: () => {} })
export const useLog = () => useContext(LogContext)

// 导航上下文（2026-11-14）：页面之间要能「跳转」而不整页刷新 —— 例：资料卡页的
// 「去补传报告」按钮要跳到「资料录入」。不引 react-router，只暴露 App 里那个 go()。
const NavContext = createContext({ go: () => {}, active: 'intake', permissions: {} })
export const useNav = () => useContext(NavContext)

const TONE_COLOR = { info: 'default', ok: 'green', warn: 'orange', err: 'red' }

export default function App() {
  const { message } = AntApp.useApp()
  const [logs, setLogs] = useState([])
  const [logOpen, setLogOpen] = useState(false)
  // 账号系统：null=加载中，false=未登录，{user,permissions}=已登录
  const [me, setMe] = useState(null)
  const loadMe = useCallback(() => {
    jget('/api/auth/me').then((j) => setMe({ user: j.user, permissions: j.permissions || {} })).catch(() => setMe(false))
  }, [])
  useEffect(() => { loadMe() }, [loadMe])
  useEffect(() => {
    const onUnauthorized = () => setMe(false)
    window.addEventListener('mb:unauthorized', onUnauthorized)
    return () => window.removeEventListener('mb:unauthorized', onUnauthorized)
  }, [])
  // 403 统一提示：不把 JSON 错误留成白屏（用户手机实际踩到）。权限类给人话，其余显原始错误。
  useEffect(() => {
    const onForbidden = (e) => {
      const raw = String(e?.detail?.error || '')
      if (raw.includes('功能未授权')) message.error('未开通导出权限，请联系管理员')
      else if (raw.includes('无权访问')) message.error('无权访问该内容')
      else if (raw) message.error(raw)
    }
    window.addEventListener('mb:forbidden', onForbidden)
    return () => window.removeEventListener('mb:forbidden', onForbidden)
  }, [message])

  const pushLog = useCallback((msg, tone = 'info') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs((prev) => [{ time, msg, tone, key: `${Date.now()}-${Math.random()}` }, ...prev].slice(0, 200))
    if (tone === 'err') message.error(msg)
  }, [message])

  const clearLogs = useCallback(() => setLogs([]), [])
  const logValue = useMemo(() => ({ logs, pushLog, clearLogs }), [logs, pushLog, clearLogs])

  // ---------- 导航（2026-11-13 换壳：顶部 6 tab → 左侧 Sider 两组）----------
  // 分组按「业务流程」而不是「技术模块」：资料线（录入→整理→出片→交换）与出诊线（看号→挂号→会话）。
  // URL 兼容：旧链接 /?merged=guahao、/#booking、/?tab=xxx 都能落到对应项（见 KEY_ALIAS）。
  const KEY_ALIAS = { guahao: 'booking', merged: 'booking', new: 'booking', orders: 'booking' }
  // 合并后的子段：?tab=orders 或 ?sub=orders 都要落到「预约记录」
  const subOf = (want) => {
    try {
      const u = new URL(window.location.href)
      return u.searchParams.get('sub') === want || u.searchParams.get('tab') === want ? want : undefined
    } catch { return undefined }
  }
  const ALL_PAGES = [
    { key: 'intake', label: '资料录入', group: '资料', node: <IntakePage />, perm: null },
    { key: 'reports', label: '报告库', group: '资料', node: <ReportsPanel />, perm: null },
    // 资料卡页面对普通用户开放（2026-11-17 用户口径第1条：能看到页面，只是不能下载/打印）
    { key: 'card', label: '资料卡', group: '资料', node: <CardPage />, perm: null },
    { key: 'brief', label: '病历交换包', group: '资料', node: <BriefPage />, perm: 'card_export' },
    { key: 'monitor', label: '出诊监控', group: '出诊', node: <MonitorPage />, perm: 'guahao' },
    // 发起挂号 + 预约记录 = 同一件事的前后半段，合并成一项（页内两段），见 pages/BookingPage.jsx
    { key: 'booking', label: '挂号与预约', group: '出诊', node: <BookingPage initialSub={subOf('orders')} />, perm: 'guahao' },
    { key: 'session', label: '114 会话', group: '出诊', node: <SessionPage />, perm: 'guahao' },
    { key: 'accounts', label: '账号管理', group: '系统', node: <AccountAdminPage />, perm: 'admin' },
  ]
  const perms = (me && me.permissions) || {}
  const isAdmin = perms.role === 'admin'
  // 账号系统：按权限过滤菜单；隐藏≠安全，后端守卫仍会 403
  const PAGES = ALL_PAGES.filter((p) => !p.perm || (p.perm === 'admin' ? isAdmin : (isAdmin || perms[p.perm])))
  const readKeyFromUrl = () => {
    const u = new URL(window.location.href)
    const raw = u.searchParams.get('tab') || u.hash.replace('#', '') || (u.searchParams.has('merged') ? 'guahao' : '')
    const k = KEY_ALIAS[raw] || raw
    // 用 ALL_PAGES 判断（而非按权限过滤后的 PAGES）：登录态还在加载时 PAGES 尚未包含需授权页，
    // 否则 ?tab=card 会被误判成 intake 并锁死（账号系统回归实测踩到）。
    return ALL_PAGES.some((p) => p.key === k) ? k : 'intake'
  }
  const [active, setActive] = useState(readKeyFromUrl)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // ≤575px 才把窄屏样式挂到 head：与 CardPage 同款（useEffect 挂载 / 卸载即移除），不污染其它条件。
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'mb-app-mobile'
    style.textContent = APP_MOBILE_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])
  // 切页写回 URL：刷新/分享/旧链接都能回到同一页（不引 react-router）
  const go = useCallback((key) => {
    setActive(key)
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('tab', key)
      u.searchParams.delete('merged')
      window.history.replaceState(null, '', u)
    } catch { /* file:// 等场景忽略 */ }
  }, [])

  // 用户口径第3条：普通用户不该看到打不开的路由分组 —— children 为空的组**整组不渲染**（连组标题消失）
  const menuItems = ['资料', '出诊', '系统']
    .map((group) => ({
      key: group,
      type: 'group',
      label: group,
      children: PAGES.filter((p) => p.group === group).map((p) => ({ key: p.key, label: p.label })),
    }))
    .filter((g) => g.children.length > 0)
  const current = PAGES.find((p) => p.key === active) || PAGES[0]

  // 账号系统：登录态守卫（加载中 / 未登录 → 登录页）
  if (me === null) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>正在加载…</div>
  if (me === false) return <LoginPage onLogged={loadMe} />

  const doLogout = async () => {
    try { await jfetch('/api/auth/logout', { method: 'POST' }) } catch {}
    setMe(false)
  }

  return (
    <NavContext.Provider value={{ go, active, permissions: perms }}>
    <LogContext.Provider value={logValue}>
      <Layout style={{ minHeight: '100vh', background: '#f5f6f8' }}>
        <Header
          style={{
            background: 'linear-gradient(90deg,#0f172a,#1e293b)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 20,
          }}
        >
          <Button
            className="mb-nav-trigger"
            aria-label="打开导航菜单"
            size="small"
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </Button>
          <Space className="mb-header-left" size={12} align="center">
            <span style={{ color: '#fff', fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>MedBrief</span>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>挂号与问诊资料整理工作台</Text>
          </Space>
          <Space className="mb-header-right">
            <Text className="mb-user-phone" style={{ color: '#94a3b8', fontSize: 12 }}>{me.user?.phone || ''}{isAdmin ? '（管理员）' : ''}</Text>
            <Button className="mb-logout" size="small" onClick={doLogout}>退出</Button>
            <Button className="mb-log-btn" size="small" onClick={() => setLogOpen(true)}>
              日志
              <Badge count={logs.length} size="small" style={{ marginLeft: 6 }} showZero={false} />
            </Button>
          </Space>
        </Header>

        <Layout>
          <Sider
            width={168}
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            breakpoint="lg"
            collapsedWidth={56}
            style={{ background: '#fff', borderRight: '1px solid #eef0f3' }}
          >
            <Menu
              mode="inline"
              selectedKeys={[active]}
              items={menuItems}
              onClick={({ key }) => go(key)}
              style={{ borderInlineEnd: 'none', paddingTop: 8 }}
            />
          </Sider>
          {/* minWidth:0 是关键：否则窄屏下内容会把容器撑出横向滚动条 */}
          <Content style={{ padding: '16px 20px 32px', minWidth: 0 }}>
            {current.node}
          </Content>
        </Layout>

        <Footer style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 12 }}>
          仅为自己挂号，不代挂、不并发抢号 · 每日 07:00 放第 14 天号源 · 资料整理不构成诊断建议
        </Footer>

        <Drawer
          title="导航菜单"
          placement="left"
          width={260}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
        >
          <Menu
            mode="inline"
            selectedKeys={[active]}
            items={menuItems}
            onClick={({ key }) => { go(key); setMenuOpen(false) }}
            style={{ borderInlineEnd: 'none' }}
          />
        </Drawer>

        <Drawer
          title={
            <Space>
              事件日志
              <Button size="small" onClick={clearLogs}>
                清空
              </Button>
            </Space>
          }
          placement="bottom"
          height={360}
          open={logOpen}
          onClose={() => setLogOpen(false)}
        >
          {logs.length === 0 ? (
            <Text type="secondary">暂无事件</Text>
          ) : (
            <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
              {logs.map((l) => (
                <div key={l.key} style={{ padding: '3px 0', borderBottom: '1px dashed #eee' }}>
                  <Text type="secondary">{l.time}</Text>{' '}
                  <Tag color={TONE_COLOR[l.tone] || 'default'} style={{ marginInline: 6 }}>
                    {l.tone}
                  </Tag>
                  <span>{l.msg}</span>
                </div>
              ))}
            </div>
          )}
        </Drawer>
      </Layout>
    </LogContext.Provider>
    </NavContext.Provider>
  )
}
