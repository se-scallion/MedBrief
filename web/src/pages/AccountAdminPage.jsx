// 管理员账号管理页（2026-11-17 补做）：建号 / 授权 / 撤销 / 改号 / 停用 / 踢下线
// 后端：GET /api/admin/users、POST /api/admin/users[/permissions|/phone|/kick]
import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { jfetch, jget } from '../api.js'

const { Title, Text } = Typography

export default function AccountAdminPage() {
  const [users, setUsers] = useState([])
  const [audit, setAudit] = useState([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(null)
  const [form] = Form.useForm()
  const [phoneForm] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await jget('/api/admin/users')
      setUsers(j.users || [])
      setAudit(j.audit || [])
    } catch (e) { message.error(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function post(action, body) {
    try {
      const j = await jfetch('/api/admin/users' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      message.success('已保存')
      await load()
      return j
    } catch (e) { message.error(e.message); throw e }
  }

  const togglePerm = (u, key, val) => post('/permissions', { id: u.id, [key]: val })
  const doCreate = async () => {
    const v = await form.validateFields()
    await post('', v)
    setCreateOpen(false); form.resetFields()
  }
  const doPhone = async () => {
    const v = await phoneForm.validateFields()
    const r = await post('/phone', { id: phoneOpen.id, phone: v.phone })
    if (r.note) message.info(r.note)
    setPhoneOpen(null); phoneForm.resetFields()
  }

  const columns = [
    { title: '手机号', dataIndex: 'phone', key: 'phone', render: (p, u) => <Space><Text>{p}</Text>{u.role === 'admin' && <Tag color="red">管理员</Tag>}</Space> },
    { title: '报告库', key: 'reports', render: (_, u) => <Switch size="small" checked disabled tooltip="登录用户均可管理自己的报告" /> },
    { title: '导出/打印', key: 'card', render: (_, u) => <Switch size="small" checked={!!u.card_export} onChange={(v) => togglePerm(u, 'card_export', v)} /> },
    { title: '挂号', key: 'gh', render: (_, u) => <Switch size="small" checked={!!u.guahao} onChange={(v) => togglePerm(u, 'guahao', v)} /> },
    { title: '状态', key: 'disabled', render: (_, u) => u.disabled ? <Tag color="default">已停用</Tag> : <Tag color="green">正常</Tag> },
    { title: '操作', key: 'op', render: (_, u) => (
      <Space size={4}>
        <Button size="small" onClick={() => { setPhoneOpen(u); phoneForm.setFieldsValue({ phone: u.phone }) }}>改号</Button>
        <Popconfirm title="踢下线？该用户全部设备需重新登录" onConfirm={() => post('/kick', { id: u.id })}>
          <Button size="small">踢下线</Button>
        </Popconfirm>
        <Popconfirm title={u.disabled ? '恢复此账号？' : '停用此账号？'} onConfirm={() => post('/permissions', { id: u.id, disabled: !u.disabled })}>
          <Button size="small" danger={!u.disabled}>{u.disabled ? '恢复' : '停用'}</Button>
        </Popconfirm>
      </Space>
    ) },
  ]

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>账号管理</Title>
        <Space>
          <Button onClick={load} loading={loading}>刷新</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>新建账号</Button>
        </Space>
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="权限说明"
        description="登录用户均可增删改查自己的报告、看不到别人的。导出/打印资料卡、查看原件、挂号需逐人授权（右侧开关，改动立即生效）。管理员可管理所有人报告与全部功能。" />
      <Table rowKey="id" size="small" loading={loading} dataSource={users} columns={columns} pagination={false} />

      <Modal title="新建账号" open={createOpen} onOk={doCreate} onCancel={() => { setCreateOpen(false); form.resetFields() }} okText="创建">
        <Form form={form} layout="vertical">
          <Form.Item label="手机号" name="phone" rules={[{ required: true, pattern: /^1\d{10}$/, message: '11 位手机号' }]}><Input maxLength={11} /></Form.Item>
          <Form.Item label="初始密码" name="password" rules={[{ required: true, min: 8, message: '至少 8 位' }]}><Input.Password /></Form.Item>
          <Form.Item label="角色" name="role" initialValue="user"><Input disabled value="user（普通用户）" /></Form.Item>
          <Form.Item label="导出/打印授权" name="card_export" valuePropName="checked" initialValue={false}><Switch /></Form.Item>
          <Form.Item label="挂号授权" name="guahao" valuePropName="checked" initialValue={false}><Switch /></Form.Item>
        </Form>
      </Modal>

      <Modal title="修改手机号" open={!!phoneOpen} onOk={doPhone} onCancel={() => setPhoneOpen(null)} okText="保存">
        <Form form={phoneForm} layout="vertical">
          <Form.Item label="新手机号" name="phone" rules={[{ required: true, pattern: /^1\d{10}$/, message: '11 位手机号' }]}><Input maxLength={11} /></Form.Item>
        </Form>
        <Text type="warning">改号会使该用户全部会话失效，需要重新登录。</Text>
      </Modal>

      {audit.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Title level={5}>最近操作审计</Title>
          <Table rowKey="id" size="small" dataSource={audit} pagination={false}
            columns={[
              { title: '时间', dataIndex: 'at', key: 'at' },
              { title: '动作', dataIndex: 'action', key: 'action' },
              { title: '目标', dataIndex: 'target_user_id', key: 'target', render: (id) => users.find((u) => u.id === id)?.phone || id || '—' },
            ]} />
        </div>
      )}
    </div>
  )
}
