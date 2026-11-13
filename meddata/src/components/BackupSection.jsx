// ===================== 整库备份 / 恢复 UI =====================
// 备份：把全部数据（化验记录 + 事件 + 报告归档原件/全文）打包下载为单个 JSON。
// 恢复：选择备份文件 → 预览内容 → 确认后覆盖恢复（换电脑/换浏览器后迁移数据用）。

import { useRef, useState } from 'react'
import { Button, Alert, Card } from 'antd'
import { exportBackup, inspectBackup, applyBackup, errMsg } from '../utils/backup.js'

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

export default function BackupSection() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null) // { ok, text }
  const [pending, setPending] = useState(null) // { backup, summary } 待确认
  const fileRef = useRef(null)

  const doBackup = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const s = await exportBackup()
      setMsg({
        ok: true,
        text: `备份已下载：${s.records} 条化验 / ${s.events} 个事件 / ${s.docs} 份归档（含 ${s.files} 个原件），文件 ${fmtBytes(s.size)}`,
      })
    } catch (e) {
      setMsg({ ok: false, text: `备份失败：${errMsg(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const onPick = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!f) return
    setBusy(true)
    setMsg(null)
    setPending(null)
    try {
      const { backup, summary } = await inspectBackup(f)
      setPending({ backup, summary })
    } catch (err) {
      setMsg({ ok: false, text: `导入失败：${errMsg(err)}` })
    } finally {
      setBusy(false)
    }
  }

  const doRestore = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const s = await applyBackup(pending.backup)
      setPending(null)
      setMsg({
        ok: true,
        text: `恢复成功：${s.records} 条化验 / ${s.events} 个事件 / ${s.docs} 份归档（${s.files} 个原件，${s.texts} 份全文）`,
      })
    } catch (err) {
      setMsg({ ok: false, text: `恢复失败：${errMsg(err)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* 备份 */}
      <Card title="导出整库备份" size="small">
        <p className="text-xs text-slate-500 mb-3">
          把全部数据打包为一个 <code className="text-slate-700">.json</code> 文件下载：
          化验记录、事件、患者信息、报告归档索引 + 原件 + 提取全文。用于换电脑 / 换浏览器时迁移数据。
        </p>
        <Button type="primary" onClick={doBackup} loading={busy}>
          {busy ? '打包中…' : '⬇ 下载整库备份'}
        </Button>
        {msg && <Alert className="mt-3" type={msg.ok ? 'success' : 'error'} message={msg.text} showIcon />}
      </Card>

      {/* 恢复 */}
      <Card title="从备份恢复" size="small">
        <p className="text-xs text-slate-500 mb-3">
          选择之前下载的备份文件，预览后一键恢复。注意：
          <span className="text-red-600 font-medium">恢复会覆盖当前浏览器里的全部数据</span>，如有疑虑请先导出备份。
        </p>
        {!pending ? (
          <Button onClick={() => fileRef.current && fileRef.current.click()} loading={busy}>
            {busy ? '读取中…' : '选择备份文件'}
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600 space-y-1">
              <p className="font-medium text-slate-700">备份内容预览</p>
              <p>导出时间：{pending.summary.exported_at.replace('T', ' ').slice(0, 16)}</p>
              <p>
                化验记录 <b>{pending.summary.records}</b> 条 · 事件 <b>{pending.summary.events}</b> 个 · 归档{' '}
                <b>{pending.summary.docs}</b> 份 · 原件 <b>{pending.summary.files}</b> 个 · 全文{' '}
                <b>{pending.summary.texts}</b> 份
              </p>
              <p className="text-slate-400">文件大小 {fmtBytes(pending.summary.size)}</p>
            </div>
            <div className="flex gap-2">
              <Button type="primary" onClick={doRestore} loading={busy}>
                {busy ? '恢复中…' : '确认恢复（覆盖）'}
              </Button>
              <Button onClick={() => setPending(null)} disabled={busy}>
                取消
              </Button>
            </div>
          </div>
        )}
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onPick} />
        {msg && !pending && <Alert className="mt-3" type={msg.ok ? 'success' : 'error'} message={msg.text} showIcon />}
      </Card>
    </div>
  )
}
