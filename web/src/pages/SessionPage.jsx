import React, { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntApp, Button, Card, Descriptions, Space, Spin, Tag, Typography } from 'antd'
import { jget, jpost } from '../api.js'
import { useLog } from '../App.jsx'

const { Text, Paragraph } = Typography

export default function SessionTab() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSession(await jget('/api/guahao/114/session'))
    } catch (e) {
      setSession({ ok: false, error: e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const launch = async () => {
    setBusy(true)
    try {
      const j = await jpost('/api/guahao/114/launch-login', {})
      pushLog(`已唤起 114 登录窗口${j.flowId ? `（${j.flowId}）` : ''}`, 'ok')
      message.success('请在弹出的窗口里完成登录')
      setTimeout(load, 3000)
    } catch (e) {
      message.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    setBusy(true)
    try {
      await jpost('/api/guahao/114/close-login', {})
      pushLog('已关闭 114 登录窗口', 'info')
      load()
    } catch (e) {
      message.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const loggedIn = session?.loggedIn

  return (
    <div>
      <Card
        size="small"
        title={
          <Space>
            <Text strong>114 账号连接</Text>
            {loading ? <Spin size="small" /> : loggedIn ? <Tag color="green">已登录</Tag> : <Tag color="orange">未登录</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button size="small" onClick={load}>
              重新检测
            </Button>
            <Button size="small" type="primary" loading={busy} onClick={launch}>
              一键唤起 114 登录窗口
            </Button>
            <Button size="small" loading={busy} onClick={close}>
              关闭窗口
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="极简登录"
          description="点上方按钮会打开 114 官方窗口，你在窗口内用手机号 + 短信验证码完成登录即可；系统自动复用浏览器登录态，不需要复制 Cookie，也不需要 F12。"
        />
        {session?.loggedIn ? (
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="手机号">{session.user?.mobile || '—'}</Descriptions.Item>
            <Descriptions.Item label="姓名">{session.user?.name || '—'}</Descriptions.Item>
            <Descriptions.Item label="身份证">{session.user?.idCard || '—'}</Descriptions.Item>
            <Descriptions.Item label="认证状态">
              <Tag color="green">{session.user?.authStatusView || '—'}</Tag>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {session?.error || '当前没有可复用的 114 登录态，请点「一键唤起 114 登录窗口」。'}
          </Paragraph>
        )}
      </Card>

      <Card size="small" style={{ marginTop: 16 }} title="排障说明">
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          票据（cmi-user-ticket）/ Cookie 手工粘贴通道已按产品口径下线为排障能力：票据直连在瑞数 WAF 下实测一律
          462，正常流程只走「唤起窗口 → 短信登录 → 复用登录态」。需要排障时请看
          <Text code>docs/114-guahao-playbook.md</Text>。
        </Paragraph>
      </Card>
    </div>
  )
}
