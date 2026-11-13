// ===================== 设置页 =====================
// 当前只承载「识别补丁」一块：把 scripts/patch-apply.mjs 的能力搬到界面上
// （列表 / 粘贴 / 校验 / 应用 / 清空 / 回滚），让"加字段、补别名"不必进命令行。
//
// 设计约束（都来自实际踩过的坑）：
//  · 写补丁 = 改代码级操作 → 服务端只允许**本机**写（远程 403），页面据 `writable` 置灰；
//  · 并发写：所有写请求携带页面加载时的 `revision`，服务端比对不一致就 409，
//    提示"已被其它会话修改" → 必须重新加载再写，绝不静默覆盖；
//  · 写坏绝不落盘：服务端 validatePatch + node --check 双闸，失败原文回显在这张卡里；
//  · 回滚 = 还原上一版 .bak，比手动删字段可靠。
//
// 后面还会加其它设置项（AI 接入 / 引擎 / 数据源 / 关于），故本页按「区块」堆叠，
// 每块自带标题与说明，不复用全局表单状态。

import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Input, Space, Tag } from 'antd'
import BackButton from './BackButton.jsx'

const API = '/api/patches'
const { TextArea } = Input

const summarize = (p) => {
  const parts = []
  if (Array.isArray(p.fields) && p.fields.length) parts.push(`字段 ${p.fields.length}`)
  if (p.aliases) parts.push(`别名 ${Object.keys(p.aliases).length} 组`)
  if (p.keyFields) parts.push(`keyFields ${Object.keys(p.keyFields).length} 组`)
  if (p.sections) parts.push('段落名')
  if (Array.isArray(p.definingCodes) && p.definingCodes.length) parts.push(`定义码 ${p.definingCodes.length}`)
  return parts.join(' / ') || '（空补丁）'
}

export default function SettingsPage({ onBack }) {
  const [state, setState] = useState({ loading: true, ok: true, revision: 0, patches: [], writable: false, error: '', parseError: '' })
  const [gaps, setGaps] = useState({ loading: true, total: 0, list: [], error: '' })
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState(null) // { kind:'ok'|'err', text }
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(API)
      const j = await res.json()
      setState({ loading: false, ok: !!j.ok, revision: j.revision || 0, patches: j.patches || [], writable: !!j.writable, error: j.error || '', parseError: j.parseError || '' })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, ok: false, error: '服务未连接（8008）：识别补丁需要网关在跑' }))
    }
  }, [])

  const loadGaps = useCallback(async () => {
    try {
      const res = await fetch('/api/gaps')
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setGaps({ loading: false, total: j.total || 0, list: j.gaps || [], error: '' })
    } catch (e) {
      setGaps({ loading: false, total: 0, list: [], error: `缺口列表读取失败：${e && e.message}` })
    }
  }, [])

  useEffect(() => {
    load()
    loadGaps()
  }, [load, loadGaps])

  const post = async (body, label) => {
    setBusy(label)
    setMsg(null)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedRevision: state.revision }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.ok) {
        setMsg({ kind: 'err', text: j.error || `请求失败（HTTP ${res.status}）` })
        if (j.conflict) await load() // 冲突后立刻刷新到最新 revision，避免连续撞车
        return false
      }
      setMsg({ kind: 'ok', text: `${label}成功：revision=${j.revision}，当前 ${j.count} 条补丁` })
      await load()
      return true
    } catch (e) {
      setMsg({ kind: 'err', text: `服务未连接：${e && e.message}` })
      return false
    } finally {
      setBusy('')
    }
  }

  const applyDraft = async () => {
    let parsed
    try {
      parsed = JSON.parse(draft)
    } catch (e) {
      setMsg({ kind: 'err', text: `不是合法 JSON：${e.message}` })
      return
    }
    const patches = Array.isArray(parsed) ? parsed : [parsed]
    if (!patches.length) {
      setMsg({ kind: 'err', text: '补丁为空' })
      return
    }
    const ok = await post({ action: 'apply', patches }, '应用')
    if (ok) setDraft('')
  }

  return (
    <div className="max-w-4xl mx-auto px-2 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <BackButton onClick={onBack} />
        <h2 className="text-lg font-semibold text-slate-800">设置</h2>
      </div>

      <Card
        size="small"
        title={
          <span className="flex items-center gap-2">
            识别补丁
            <Tag color="blue">revision {state.revision}</Tag>
            <Tag color={state.patches.length ? 'orange' : 'default'}>{state.patches.length} 条生效</Tag>
          </span>
        }
        extra={
          <Space>
            <Button size="small" onClick={load} loading={state.loading}>
              刷新
            </Button>
            <Button size="small" disabled={!state.writable || !!busy || !state.patches.length} onClick={() => post({ action: 'clear' }, '清空')}>
              清空
            </Button>
            <Button size="small" danger disabled={!state.writable || !!busy} onClick={() => post({ action: 'rollback' }, '回滚')}>
              回滚上一版
            </Button>
          </Space>
        }
      >
        <p className="text-[11px] text-slate-500 mb-2">
          加字段 / 补别名 / 补标题词 / 补段落名写在这里，写进 <code>src/data/patches.js</code> 即生效，清空或回滚即撤销。
          改了逻辑（解析、反推规则）才需要改源码 + 跑门禁，不属于这里。
        </p>

        {!state.writable && (
          <Alert
            className="mb-2"
            type="info"
            showIcon
            message="只读：识别补丁只能在服务器本机修改"
            description="补丁会即时影响识别结果，属改代码级操作，远程访问仅可查看。"
          />
        )}
        {state.parseError && <Alert className="mb-2" type="error" showIcon message="补丁文件损坏" description={`${state.parseError}（可点「回滚上一版」救回）`} />}
        {state.error && !state.parseError && <Alert className="mb-2" type="error" showIcon message={state.error} />}
        {msg && <Alert className="mb-2" type={msg.kind === 'ok' ? 'success' : 'error'} showIcon message={msg.text} />}

        {state.patches.length > 0 ? (
          <ul className="mb-3 divide-y divide-slate-100 rounded border border-slate-200">
            {state.patches.map((p, i) => (
              <li key={p.id || i} className="px-2 py-1.5 text-xs">
                <span className="font-mono text-slate-700">{p.id || '(无 id)'}</span>
                <span className="ml-2 text-slate-500">{summarize(p)}</span>
                {p.note ? <span className="ml-2 text-slate-400">· {p.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mb-3 rounded border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
            当前没有生效补丁（说明识别完全走源码里的静态字典）
          </div>
        )}

        <TextArea
          rows={8}
          value={draft}
          disabled={!state.writable}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`粘贴补丁 JSON（数组或单个对象），例：\n{\n  "id": "opt-20261030-xxx",\n  "note": "补 3 个细胞系字段",\n  "fields": [{ "code": "MYELO", "name": "幼稚粒细胞", "unit": "%", "ref": "0-5", "group": "骨髓形态学" }]\n}`}
          className="font-mono text-xs"
          data-testid="patch-draft"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button type="primary" size="small" loading={busy === '应用'} disabled={!state.writable || !draft.trim()} onClick={applyDraft} data-testid="patch-apply">
            校验并应用
          </Button>
          <Button size="small" disabled={!state.writable || !draft.trim()} onClick={() => setDraft('')}>
            清空输入框
          </Button>
          <span className="text-[11px] text-slate-400">校验失败会原文回显，不会落盘、不会影响正在跑的识别。</span>
        </div>
      </Card>

      <Card
        size="small"
        title={
          <span className="flex items-center gap-2">
            待处理缺口
            <Tag color={gaps.total ? 'orange' : 'default'}>{gaps.total} 份报告</Tag>
          </span>
        }
        extra={
          <Button size="small" onClick={loadGaps} loading={gaps.loading}>
            刷新
          </Button>
        }
      >
        <p className="text-[11px] text-slate-500 mb-2">
          近期导入里「字典不认识的项目」达到阈值（≥2 项且名称可读）时，会连同一份补丁草稿记在这里。
          草稿只是提议：code 是占位符，确认 name/unit/ref 后点「填入草稿」再「校验并应用」。
        </p>
        {gaps.error && <Alert className="mb-2" type="error" showIcon message={gaps.error} />}
        {!gaps.error && !gaps.list.length ? (
          <div className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
            近两周没有待处理缺口
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 rounded border border-slate-200">
            {gaps.list.map((g) => (
              <li key={g.traceId} className="px-2 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-500">{g.traceId}</span>
                  <Tag>{g.reportType || '未知类型'}</Tag>
                  <span className="text-slate-500">{g.count} 项未收录</span>
                  <span className="ml-auto text-slate-400">{String(g.at).slice(5, 16).replace('T', ' ')}</span>
                  <Button
                    size="small"
                    disabled={!state.writable || !g.draft}
                    onClick={() => {
                      setDraft(JSON.stringify(g.draft, null, 2))
                      setMsg({ kind: 'ok', text: `已把 ${g.traceId} 的草稿填入下方输入框（记得先改 code）` })
                    }}
                    data-testid={`gap-fill-${g.traceId}`}
                  >
                    填入草稿
                  </Button>
                </div>
                <div className="mt-1 text-slate-500">
                  {g.items.map((it) => it.name).join('、')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card size="small" title="即将支持">
        <ul className="text-xs text-slate-500 space-y-1 list-disc pl-5">
          <li>AI 接入：网关地址 / 密钥 / 模型 / 测试连接（自带 key，key 只存本机）</li>
          <li>识别：默认引擎、云端同意、自动升级阈值</li>
          <li>数据与诊断：数据源地址与密钥、导出备份、版本与诊断</li>
        </ul>
      </Card>
    </div>
  )
}
