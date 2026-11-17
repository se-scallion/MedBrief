// 登录页（账号系统 v0.8）：手机号 + 密码；成功后由 App 重新拉 /api/auth/me
import React, { useState } from 'react'
import { Button, Card, Form, Input, Typography, message } from 'antd'
import { jfetch } from '../api.js'

const { Title, Text } = Typography

export default function LoginPage({ onLogged }) {
  const [loading, setLoading] = useState(false)

  async function submit(values) {
    setLoading(true)
    try {
      await jfetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) })
      message.success('登录成功')
      onLogged()
    } catch (e) {
      message.error(e.message || '登录失败')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8' }}>
      <Card style={{ width: 360, boxShadow: '0 8px 24px rgba(0,0,0,.08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Title level={3} style={{ marginBottom: 4 }}>MedBrief</Title>
          <Text type="secondary">挂号与问诊资料整理工作台</Text>
        </div>
        <Form layout="vertical" onFinish={submit} initialValues={{ phone: '' }} className="mb-login-form">
          <Form.Item label="手机号" name="phone" rules={[{ required: true, pattern: /^1\d{10}$/, message: '请输入 11 位手机号' }]}>
            <Input size="large" inputMode="numeric" maxLength={11} placeholder="13200000000" autoComplete="username" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          {/* U13（AI 审核 r1）：登录是全站唯一入口，按钮热区必须 ≥44；输入框字号 16px 防 iOS 聚焦自动放大 */}
          <style>{`.mb-login-form .ant-input, .mb-login-form .ant-input-affix-wrapper { font-size: 16px; min-height: 44px; }`}</style>
          <Button type="primary" htmlType="submit" block loading={loading} style={{ height: 44 }}>登录</Button>
        </Form>
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>账号由管理员创建；无账号请联系管理员</Text>
        </div>
      </Card>
    </div>
  )
}
