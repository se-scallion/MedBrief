// ===================== 数据源设置（SQLite 唯一数据源） =====================
// 数据存在项目机的 SQLite 里，两台电脑都连它 → 天然共享，不需要导出导入。
// 这里的开关决定本机是否连接数据源；关闭时退化为纯本地（离线可用，数据不共享）。

import { useEffect, useState } from 'react'
import { Card, Input, Button, Switch, Alert, Space } from 'antd'
import {
  getConfig,
  setConfig,
  getStatus,
  subscribe,
  pull,
  push,
  uploadLocalData,
  initDataSource,
  stopDataSource,
  ackEmptyGuard,
} from '../utils/apiStore.js'

const STATE_TEXT = {
  off: '未连接',
  syncing: '同步中',
  ok: '已连接',
  error: '连接异常',
}

export default function DataSourceSection() {
  const [cfg, setCfg] = useState(getConfig())
  const [status, setStatus] = useState(getStatus())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => subscribe(() => setStatus(getStatus())), [])

  const apply = async (patch) => {
    const next = setConfig(patch)
    setCfg(next)
    if (next.enabled) await initDataSource()
    else stopDataSource()
    setStatus(getStatus())
  }

  const run = async (fn, okText) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      setMsg({ ok: true, text: okText(r) })
    } catch (e) {
      setMsg({ ok: false, text: String((e && e.message) || e) })
    } finally {
      setBusy(false)
      setStatus(getStatus())
    }
  }

  return (
    <Card title="数据源（两台电脑共用一份数据）" size="small">
      <p className="text-xs text-slate-500 mb-3">
        开启后，数据统一存放在项目机的 SQLite 里，两台电脑看到的都是同一份，无需再导出导入。
        本机仍保留一份缓存，断网时可继续查看。
      </p>

      <div className="flex items-center gap-2 mb-3">
        <Switch checked={cfg.enabled} onChange={(v) => apply({ enabled: v })} />
        <span className="text-sm">{cfg.enabled ? '已连接数据源' : '仅本机（不共享）'}</span>
        <span className="text-xs text-slate-400">状态：{STATE_TEXT[status.state] || status.state}</span>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <Input
          addonBefore="地址"
          placeholder="/api/data（同源）或 http://<项目机IP>:8787/api"
          value={cfg.baseUrl}
          onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
          onBlur={(e) => apply({ baseUrl: e.target.value.trim() })}
        />
        <Input
          addonBefore="口令"
          placeholder="内网部署一般留空"
          value={cfg.token}
          onChange={(e) => setCfg({ ...cfg, token: e.target.value })}
          onBlur={(e) => apply({ token: e.target.value.trim() })}
        />
      </div>

      <Space className="mt-3">
        <Button onClick={() => run(pull, () => '已从数据源拉取最新数据')} loading={busy}>
          立即拉取
        </Button>
        <Button onClick={() => run(push, () => '已推送本机改动')} loading={busy}>
          立即推送
        </Button>
        <Button
          type="primary"
          onClick={() => run(uploadLocalData, (r) => `已重新上传本机数据：原件 ${r.files} 份 / 全文 ${r.texts} 份 / 原图 ${r.images} 张`)}
          loading={busy}
        >
          重新上传本机数据（兜底）
        </Button>
        <Button
          danger
          onClick={() => {
            if (!window.confirm('确认用本机数据覆盖数据源？服务端现有数据将被本机内容替换（含删除）。')) return
            ackEmptyGuard()
            run(push, '已按确认强制推送本机数据')
          }}
          loading={busy}
        >
          强制覆盖数据源（本机为准）
        </Button>
      </Space>

      {status.lastSyncAt && (
        <p className="text-xs text-slate-400 mt-3">
          版本 {status.version} · 上次同步 {status.lastSyncAt.replace('T', ' ').slice(0, 19)}
        </p>
      )}
      {status.state === 'error' && status.error && (
        <Alert className="mt-3" type="error" showIcon message={`连不上数据源：${status.error}`} />
      )}
      {msg && <Alert className="mt-3" type={msg.ok ? 'success' : 'error'} showIcon message={msg.text} />}

      <p className="text-xs text-slate-400 mt-3">
        首次开启会自动把本机已有旧数据迁到项目机（唯一数据源），无需手动上传；另一台电脑开启后自动拉取同一份。
      </p>
    </Card>
  )
}
