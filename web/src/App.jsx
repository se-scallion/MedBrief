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
  /* 汉堡按钮是左 Space 第 1 项之外的 Header 直接子元素（见 JSX）：桌面 display:none，
     窄屏绝对定位在左侧；MedBrief / 院区 Tag / 副标题仍是左 Space 的第 1/2/3 项。
     只隐藏第 2、3 项，标题保持可见（旧 CardPage 规则按 2|3 隐藏会误伤，已搬走删除）。
     padding-inline 必须 !important：Header 有内联 style paddingInline:20，层叠最高。 */
  .ant-layout-header { position: relative; }
  .mb-header-left > .ant-space-item:nth-child(2),
  .mb-header-left > .ant-space-item:nth-child(3) { display: none !important; }
  .mb-header-left { margin-left: 36px; }
  .mb-nav-trigger { display: inline-flex !important; }
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
const NavContext = createContext({ go: () => {}, active: 'intake' })
export const useNav = () => useContext(NavContext)

const TONE_COLOR = { info: 'default', ok: 'green', warn: 'orange', err: 'red' }

export default function App() {
  const { message } = AntApp.useApp()
  const [logs, setLogs] = useState([])
  const [logOpen, setLogOpen] = useState(false)

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
  const PAGES = [
    { key: 'intake', label: '资料录入', group: '资料', node: <IntakePage /> },
    { key: 'reports', label: '报告库', group: '资料', node: <ReportsPanel /> },
    { key: 'card', label: '资料卡', group: '资料', node: <CardPage /> },
    { key: 'brief', label: '病历交换包', group: '资料', node: <BriefPage /> },
    { key: 'monitor', label: '出诊监控', group: '出诊', node: <MonitorPage /> },
    // 发起挂号 + 预约记录 = 同一件事的前后半段，合并成一项（页内两段），见 pages/BookingPage.jsx
    { key: 'booking', label: '挂号与预约', group: '出诊', node: <BookingPage initialSub={subOf('orders')} /> },
    { key: 'session', label: '114 会话', group: '出诊', node: <SessionPage /> },
  ]
  const readKeyFromUrl = () => {
    const u = new URL(window.location.href)
    const raw = u.searchParams.get('tab') || u.hash.replace('#', '') || (u.searchParams.has('merged') ? 'guahao' : '')
    const k = KEY_ALIAS[raw] || raw
    return PAGES.some((p) => p.key === k) ? k : 'intake'
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

  const menuItems = ['资料', '出诊'].map((group) => ({
    key: group,
    type: 'group',
    label: group,
    children: PAGES.filter((p) => p.group === group).map((p) => ({ key: p.key, label: p.label })),
  }))
  const current = PAGES.find((p) => p.key === active) || PAGES[0]

  return (
    <NavContext.Provider value={{ go, active }}>
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
            <Tag color="red">北京朝阳医院 · 血液内科 · 主鸿鹄</Tag>
            <Text style={{ color: '#94a3b8', fontSize: 12 }}>挂号与问诊资料整理工作台</Text>
          </Space>
          <Space>
            <Button
              size="small"
              onClick={() => setLogOpen(true)}
            >
              事件日志
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
