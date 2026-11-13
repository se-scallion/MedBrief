import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { jget, jpost } from './api.js'
import { useLog } from './App.jsx'

const { Text, Paragraph } = Typography

/**
 * 「登录凭据」面板：114 账号连接与登录态（挂在 /settings 下）。
 *
 * 只做四件事：
 *   1. 唤起 / 关闭 114 官方登录窗口；
 *   2. 展示登录态（脱敏），可重新检测；
 *   3. 一句话说明能力边界：登录可自动化、选号需人工；
 *   4. 开发者调试区（默认折叠）——票据/ Cookie 手工通道，明确标注不可给患者用。
 *
 * 安全约定：手机号一律用后端给的脱敏串渲染；ticket / cookie 的值不渲染成文本、不进 console。
 */
export default function AuthPane() {
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()

  const [session, setSession] = useState(null)
  const [sessionLoading, setSessionLoading] = useState(true)

  const [winBusy, setWinBusy] = useState(false)
  const [winLaunched, setWinLaunched] = useState(false)

  const [authState, setAuthState] = useState(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [ticket, setTicket] = useState('')
  const [cookie, setCookie] = useState('')

  // ---------- 登录态 ----------
  const loadSession = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setSessionLoading(true)
    try {
      const j = await jget('/api/guahao/114/session')
      setSession(j.loggedIn ? { loggedIn: true, user: j.user } : { loggedIn: false, error: j.error })
    } catch (e) {
      setSession({ loggedIn: false, error: e.message })
    } finally {
      setSessionLoading(false)
    }
  }, [])

  // ---------- 排障区：凭据状态（只读，不回显值） ----------
  const loadAuthState = useCallback(async () => {
    try {
      setAuthState(await jget('/api/guahao/114/auth'))
    } catch (e) {
      setAuthState({ ok: false, error: e.message })
    }
  }, [])

  useEffect(() => {
    loadSession()
    loadAuthState()
  }, [loadSession, loadAuthState])

  // ---------- 登录窗口 ----------
  const launch = async () => {
    setWinBusy(true)
    try {
      await jpost('/api/guahao/114/launch-login', {})
      setWinLaunched(true)
      pushLog('已唤起 114 官方登录窗口，请在弹出的窗口里完成扫码或短信登录', 'ok')
      message.success('登录窗口已唤起，完成后回来点「重新检测登录态」')
      setTimeout(() => loadSession({ quiet: true }), 20000)
    } catch (e) {
      message.error(e.message)
      pushLog(`唤起登录窗口失败：${e.message}`, 'err')
    } finally {
      setWinBusy(false)
    }
  }

  const closeWindow = async () => {
    setWinBusy(true)
    try {
      await jpost('/api/guahao/114/close-login', {})
      setWinLaunched(false)
      pushLog('已关闭 114 登录窗口', 'info')
      message.info('登录窗口已关闭')
    } catch (e) {
      message.error(e.message)
    } finally {
      setWinBusy(false)
    }
  }

  // ---------- 排障区动作 ----------
  const saveCredentials = async () => {
    const t = ticket.trim()
    const c = cookie.trim()
    if (!t && !c) {
      message.warning('票据与 Cookie 都为空，没有可保存的内容')
      return
    }
    setAuthBusy(true)
    try {
      const j = await jpost('/api/guahao/114/auth', { ticket: t, cookie: c })
      setTicket('')
      setCookie('')
      await loadAuthState()
      await loadSession({ quiet: true })
      pushLog(`已提交排障凭据（票据 ${t ? t.length : 0} 字符 / Cookie ${c ? c.length : 0} 字符）`, 'warn')
      if (j.isLogin) message.success('凭据已保存，且 114 鉴权通过')
      else message.warning(j.message || '凭据已保存，但 114 鉴权未通过')
    } catch (e) {
      message.error(e.message)
      pushLog(`排障凭据提交失败：${e.message}`, 'err')
    } finally {
      setAuthBusy(false)
    }
  }

  const clearCredentials = async () => {
    setAuthBusy(true)
    try {
      await jpost('/api/guahao/114/auth', { ticket: '', cookie: '' })
      setTicket('')
      setCookie('')
      await loadAuthState()
      pushLog('已清空排障凭据', 'info')
      message.info('凭据已清空')
    } catch (e) {
      message.error(e.message)
    } finally {
      setAuthBusy(false)
    }
  }

  const loggedIn = !!session?.loggedIn
  const user = session?.user || {}

  const devItems = [
    {
      key: 'dev',
      label: '开发者调试区（普通患者请忽略）',
      children: (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="这不是给患者用的"
            description={
              <Space direction="vertical" size={2}>
                <Text>
                  正常使用只需上方「唤起 114 登录窗口」。下面的字段要求从浏览器开发者工具手工复制凭据，
                  已被产品口径禁止（面向普通患者、禁止 F12）。
                </Text>
                <Text type="secondary">
                  保留仅为排障。票据直连在瑞数 WAF 下实测返回 462，正常登录请走浏览器窗口或流程接口。
                </Text>
              </Space>
            }
          />

          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="票据状态">
              {authState?.hasTicket ? (
                <Space size={6}>
                  <Tag color="green">已保存</Tag>
                  <Text code>{authState?.maskedTicket || '****'}</Text>
                </Space>
              ) : (
                <Tag>未保存</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Cookie 状态">
              {authState?.hasCookie ? <Tag color="green">已保存</Tag> : <Tag>未保存</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">
              <Text type="secondary">
                {authState?.updatedAt ? new Date(authState.updatedAt).toLocaleString('zh-CN') : '—'}
              </Text>
            </Descriptions.Item>
          </Descriptions>

          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              用户票据（cmi-user-ticket）
            </Text>
            <Input.Password
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="仅排障用；正常流程请留空"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              完整 Cookie（可选）
            </Text>
            <Input.TextArea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="仅排障用；提交后立即从表单清空"
              autoComplete="off"
              spellCheck={false}
              rows={2}
            />
          </div>

          <Space>
            <Button size="small" onClick={saveCredentials} loading={authBusy}>
              保存并验证
            </Button>
            <Button size="small" danger onClick={clearCredentials} loading={authBusy}>
              清空凭据
            </Button>
            <Button size="small" type="text" onClick={loadAuthState}>
              刷新状态
            </Button>
          </Space>

          <Text type="secondary" style={{ fontSize: 12 }}>
            提交后表单即清空，值不会渲染到页面文本、也不会写入 console。
          </Text>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 1. 登录窗口 */}
      <Card size="small" title="114 官方账号连接">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
            点击下方按钮，系统会在你的屏幕上打开 114 官方登录窗口。在窗口里完成微信扫码或短信验证码登录即可，
            登录态会保存在本机浏览器里，之后不必每次重登。
          </Paragraph>
          <Space wrap>
            <Button type="primary" onClick={launch} loading={winBusy}>
              唤起 114 登录窗口
            </Button>
            <Button onClick={closeWindow} loading={winBusy} disabled={!winLaunched}>
              关闭登录窗口
            </Button>
            {winLaunched && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                窗口已唤起，完成后点「重新检测登录态」
              </Text>
            )}
          </Space>
        </Space>
      </Card>

      {/* 2. 登录态 */}
      <Card
        size="small"
        title="登录态"
        extra={
          <Button size="small" onClick={() => loadSession()} loading={sessionLoading}>
            重新检测登录态
          </Button>
        }
      >
        {sessionLoading ? (
          <Space>
            <Spin size="small" />
            <Text type="secondary">正在检测…</Text>
          </Space>
        ) : loggedIn ? (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="状态">
              <Tag color="green">已登录</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="手机号">
              <Text>{user.mobile || '—'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="姓名">
              <Text>{user.name || '—'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="实名认证">
              <Tag color={user.authStatus === 1 ? 'green' : 'orange'}>{user.authStatusView || '未知'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="证件">
              <Text>{user.idCard || '—'}</Text>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Alert
            type="info"
            showIcon
            message="当前没有可用的 114 登录态"
            description={
              <Space direction="vertical" size={2}>
                <Text>点上方「唤起 114 登录窗口」完成登录后再检测。</Text>
                {session?.error && <Text type="secondary">检测信息：{session.error}</Text>}
              </Space>
            }
          />
        )}
      </Card>

      {/* 3. 能力边界 */}
      <Card size="small" title="流程边界">
        <Text>
          登录可以自动化，<Text strong>选号不行</Text>：号源接口会被瑞数 WAF 拦截（HTTP 461），
          选日期、选医生、点提交需要在已登录的浏览器窗口里人工完成。
        </Text>
      </Card>

      {/* 4. 排障区（默认折叠） */}
      <Card size="small" title="排障">
        <Collapse items={devItems} defaultActiveKey={[]} ghost />
      </Card>
    </Space>
  )
}
