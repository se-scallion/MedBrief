import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  App as AntApp,
  Badge,
  Button,
  Drawer,
  Layout,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import MonitorTab from './tabs/MonitorTab.jsx'
import BookingTab from './tabs/BookingTab.jsx'
import BriefTab from './tabs/BriefTab.jsx'
import OrdersTab from './tabs/OrdersTab.jsx'
import SessionTab from './tabs/SessionTab.jsx'
import IntakePage from './pages/IntakePage.jsx'

const { Header, Content, Footer } = Layout
const { Text } = Typography

// ---------- 全局事件日志（各 tab 共用，替代旧页面的 appendLog） ----------
const LogContext = createContext({ logs: [], pushLog: () => {}, clearLogs: () => {} })
export const useLog = () => useContext(LogContext)

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

  const items = [
    { key: 'intake', label: '资料导入', children: <IntakePage /> },
    { key: 'monitor', label: '出诊监控', children: <MonitorTab /> },
    { key: 'booking', label: '挂号与预约', children: <BookingTab /> },
    { key: 'brief', label: '病历资料', children: <BriefTab /> },
    { key: 'orders', label: '预约记录', children: <OrdersTab /> },
    { key: 'session', label: '114 会话', children: <SessionTab /> },
  ]

  return (
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
          <Space size={12} align="center">
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

        <Content style={{ padding: '16px 20px 32px' }}>
          <Tabs defaultActiveKey="intake" items={items} destroyOnHidden={false} />
        </Content>

        <Footer style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 12 }}>
          仅为自己挂号，不代挂、不并发抢号 · 每日 07:00 放第 14 天号源 · 资料整理不构成诊断建议
        </Footer>

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
  )
}
