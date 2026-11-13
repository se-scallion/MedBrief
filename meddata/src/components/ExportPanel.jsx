// ===================== AI 结构化数据导出引擎 =====================

import { useMemo, useState } from 'react'
import { InputNumber, Select, Input, Button, Tabs, Card, Space } from 'antd'
import {
  toMarkdown,
  toMarkdownAll,
  buildJsonAll,
  buildOverviewMarkdown,
  buildOverviewJson,
  filterRecordsByCategories,
  listRecordCategories,
  copyText,
  PROMPT_TEMPLATES,
  buildPrompt,
  docsToMarkdown,
  docsToJson,
  casesToMarkdown,
  casesToJson,
  markerEventsOf,
  tempToMarkdown,
  downloadText,
} from '../utils/export.js'
import { tempEventsOf } from '../utils/temperature.js'
import { useStore, updatePatientMeta } from '../data/store.js'
import BackupSection from './BackupSection.jsx'
import DataSourceSection from './DataSourceSection.jsx'

function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false)
  const doCopy = async () => {
    const ok = await copyText(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <Button type={copied ? 'primary' : 'default'} size="small" onClick={doCopy}>
      {copied ? '✓ 已复制' : label}
    </Button>
  )
}

function DownloadButton({ filename, text, label = '下载' }) {
  return (
    <Button size="small" onClick={() => downloadText(filename, text)}>
      {label}
    </Button>
  )
}

// 体温导出文件名时间戳：体温记录_2026-09-06_1530.csv
function tempStamp(ext) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
  return `体温记录_${stamp}.${ext}`
}

export default function ExportPanel({ records, events = [], docs = [], cases = [], patientMeta }) {
  const [tab, setTab] = useState('overview')
  const [meta, setMeta] = useState({ ...patientMeta })
  const markerCount = useMemo(() => markerEventsOf(events).length, [events])
  const [selectedId, setSelectedId] = useState(records.length ? records[records.length - 1].id : '')
  const [templateId, setTemplateId] = useState('A')
  const [selectedCats, setSelectedCats] = useState(null) // null = 全选

  const docsMarkdownText = useMemo(() => docsToMarkdown(docs, meta), [docs, meta])
  const docsJsonText = useMemo(() => JSON.stringify(docsToJson(docs), null, 2), [docs])
  const casesMarkdownText = useMemo(() => casesToMarkdown(cases, meta), [cases, meta])
  const casesJsonText = useMemo(() => JSON.stringify(casesToJson(cases), null, 2), [cases])

  // 体温导出：阈值取 store（与首页预警一致），事件用 tempEventsOf 升序
  const state = useStore()
  const tempThresholds = state.feverThresholds || { low: 37.3, high: 38.5 }
  const tempEvents = useMemo(() => tempEventsOf(events), [events])
  const tempMarkdownText = useMemo(() => tempToMarkdown(tempEvents, tempThresholds, meta), [tempEvents, tempThresholds, meta])

  const allCats = useMemo(() => listRecordCategories(records), [records])
  const filteredRecords = useMemo(() => filterRecordsByCategories(records, selectedCats), [records, selectedCats])

  const sorted = useMemo(() => [...filteredRecords].sort((a, b) => (a.date < b.date ? -1 : 1)), [filteredRecords])
  const record = sorted.find((r) => r.id === selectedId) || sorted[sorted.length - 1] || null

  const markdownText = useMemo(() => (record ? toMarkdown(record, meta) : ''), [record, meta])
  const markdownAllText = useMemo(() => toMarkdownAll(filteredRecords, meta), [filteredRecords, meta])
  const jsonAllText = useMemo(
    () => JSON.stringify(buildJsonAll(filteredRecords, events, meta), null, 2),
    [filteredRecords, events, meta]
  )
  const overviewMarkdownText = useMemo(
    () => buildOverviewMarkdown(filteredRecords, events, meta),
    [filteredRecords, events, meta]
  )
  const overviewJsonText = useMemo(
    () => JSON.stringify(buildOverviewJson(filteredRecords, events, meta), null, 2),
    [filteredRecords, events, meta]
  )
  const promptText = useMemo(
    () => (record ? buildPrompt(templateId, record, meta, filteredRecords) : ''),
    [templateId, record, meta, filteredRecords]
  )

  const toggleCat = (key) => {
    setSelectedCats((prev) => {
      const cur = prev === null ? allCats.map((c) => c.key) : prev
      if (cur.includes(key)) {
        if (cur.length <= 1) return prev // 至少保留一种
        return cur.filter((x) => x !== key)
      }
      return [...cur, key]
    })
  }

  const saveMeta = (patch) => {
    const next = { ...meta, ...patch }
    setMeta(next)
    updatePatientMeta(next)
  }

  // 报告类型筛选条（作用于总览 / Markdown / JSON / Prompt 全部导出）
  const typeFilter = allCats.length > 1 && (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <span className="text-xs text-slate-500 font-medium">报告类型筛选：</span>
      <Button
        size="small"
        type={selectedCats === null ? 'primary' : 'default'}
        onClick={() => setSelectedCats(null)}
      >
        全部 ({records.length})
      </Button>
      {allCats.map((c) => {
        const on = selectedCats === null || selectedCats.includes(c.key)
        return (
          <Button key={c.key} size="small" type={on ? 'primary' : 'default'} onClick={() => toggleCat(c.key)}>
            {c.label} ({c.count})
          </Button>
        )
      })}
    </div>
  )

  const tabItems = [
    {
      key: 'overview',
      label: '全病程总览',
      children: (
        <div>
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <p className="text-xs text-slate-400">
              按检测报告类型分类 · 行 = 指标，列 = 日期，单元格 = 数值 + 状态（<span className="text-red-500">↓ 偏低</span>{' '}
              <span className="text-orange-500">↑ 偏高</span> <span className="text-red-600 font-semibold">!! 危急</span>）·{' '}
              同一天多次检测取最后一份
            </p>
            <Space>
              <CopyButton text={overviewJsonText} label="复制 JSON" />
              <CopyButton text={overviewMarkdownText} label="复制 Markdown 总览" />
            </Space>
          </div>
          {filteredRecords.length === 0 ? (
            <pre className="bg-slate-900 text-slate-400 rounded-lg p-4 text-xs overflow-auto max-h-96">
              当前筛选下暂无化验记录。先保存化验记录，或调整报告类型筛选。
            </pre>
          ) : (
            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
              {overviewMarkdownText}
            </pre>
          )}
        </div>
      ),
    },
    {
      key: 'markdown',
      label: 'Markdown',
      children: (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-400">
              Markdown 表格（可直接粘贴给 Claude / ChatGPT / DeepSeek）
            </p>
            <Space>
              <CopyButton text={markdownAllText} label="复制全部记录" />
              <CopyButton text={markdownText} label="复制当前记录" />
            </Space>
          </div>
          <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
            {markdownText || '请先保存一条化验记录'}
          </pre>
        </div>
      ),
    },
    {
      key: 'json',
      label: 'JSON',
      children: (
        <div>
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <p className="text-xs text-slate-400">
              多日深度结构化数据（{filteredRecords.length} 份报告 / {markerCount} 个治疗事件 / 按指标纵向序列，含
              indicator_series）
            </p>
            <CopyButton text={jsonAllText} />
          </div>
          <pre className="bg-slate-900 text-emerald-300 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
            {jsonAllText}
          </pre>
        </div>
      ),
    },
    {
      key: 'prompt',
      label: 'Prompt 模板',
      children: (
        <div>
          <p className="text-xs text-slate-400 mb-2">选择内置模板，自动拼接当前记录数据</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {PROMPT_TEMPLATES.map((t) => (
              <Button
                key={t.id}
                size="small"
                type={templateId === t.id ? 'primary' : 'default'}
                onClick={() => setTemplateId(t.id)}
              >
                {t.name}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-400">生成后的完整提问文本</p>
            <CopyButton text={promptText} label="复制 Prompt" />
          </div>
          <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
            {promptText || '请先保存一条化验记录'}
          </pre>
        </div>
      ),
    },
    {
      key: 'docs',
      label: `报告归档 (${docs.length})`,
      children: (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-400">
              影像 / 心电报告归档索引（{docs.length} 份 · 原件保存在本地，这里导出提取的文本与结论，可结合化验趋势做综合病程分析）
            </p>
            <Space>
              <CopyButton text={docsMarkdownText} label="复制 Markdown 索引" />
              <CopyButton text={docsJsonText} label="复制 JSON 索引" />
            </Space>
          </div>
          {docs.length === 0 ? (
            <pre className="bg-slate-900 text-slate-400 rounded-lg p-4 text-xs overflow-auto max-h-96">
              暂无报告归档。可上传影像 / 心电报告 PDF，系统会保存原件并自动提取生成索引。
            </pre>
          ) : (
            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
              {docsMarkdownText}
            </pre>
          )}
        </div>
      ),
    },
    {
      key: 'cases',
      label: `病历文书 (${cases.length})`,
      children: (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-400">
              病历文书归档索引（出院记录 / 诊断证明等，{cases.length} 份 · 原件保存在本地，这里导出结构化字段与索引，可结合化验趋势做综合病程分析）
            </p>
            <Space>
              <CopyButton text={casesMarkdownText} label="复制 Markdown 索引" />
              <CopyButton text={casesJsonText} label="复制 JSON 索引" />
            </Space>
          </div>
          {cases.length === 0 ? (
            <pre className="bg-slate-900 text-slate-400 rounded-lg p-4 text-xs overflow-auto max-h-96">
              暂无病历文书。可在「文书」页上传出院记录 / 诊断证明，系统会自动抽取出院日期、出院诊断、出院医嘱等结构化字段。
            </pre>
          ) : (
            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
              {casesMarkdownText}
            </pre>
          )}
        </div>
      ),
    },
    {
      key: 'temp',
      label: `体温 (${tempEvents.length})`,
      children: (
        <div>
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <p className="text-xs text-slate-400">
              体温记录导出（{tempEvents.length} 条 · Markdown · 分级按预警阈值 low≥{tempThresholds.low} / high≥
              {tempThresholds.high}℃）
            </p>
            <Space>
              <DownloadButton filename={tempStamp('md')} text={tempMarkdownText} label="下载 MD" />
              <CopyButton text={tempMarkdownText} label="复制 Markdown" />
            </Space>
          </div>
          {tempEvents.length === 0 ? (
            <pre className="bg-slate-900 text-slate-400 rounded-lg p-4 text-xs overflow-auto max-h-96">
              暂无体温记录。可在首页体温卡「＋记体温」录入，或维护日程页用药/输血事件。
            </pre>
          ) : (
            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs leading-relaxed overflow-auto max-h-96 whitespace-pre-wrap">
              {tempMarkdownText}
            </pre>
          )}
        </div>
      ),
    },
    {
      key: 'backup',
      label: '整库备份',
      children: <BackupSection />,
    },
    {
      key: 'datasource',
      label: '数据源',
      children: <DataSourceSection />,
    },
  ]

  return (
    <div className="space-y-4">
      {/* 患者信息 */}
      <Card title="患者基础信息（将注入 AI Prompt）" size="small">
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="label">年龄</label>
            <InputNumber
              className="w-full"
              min={0}
              value={meta.age ?? ''}
              onChange={(v) => saveMeta({ age: Number(v) || 0 })}
            />
          </div>
          <div>
            <label className="label">性别</label>
            <Select
              className="w-full"
              value={meta.gender}
              onChange={(v) => saveMeta({ gender: v })}
              options={[
                { value: 'Male', label: 'Male' },
                { value: 'Female', label: 'Female' },
                { value: 'Other', label: 'Other' },
              ]}
            />
          </div>
          <div className="md:col-span-2">
            <label className="label">诊断</label>
            <Input value={meta.diagnosis} onChange={(e) => saveMeta({ diagnosis: e.target.value })} />
          </div>
        </div>
      </Card>

      {/* 记录选择 + 格式切换 */}
      <Card
        size="small"
        title={
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[260px] flex-1">
              <label className="label">导出记录（按日期排序）</label>
              <Select
                className="w-full"
                value={record ? record.id : undefined}
                onChange={(v) => setSelectedId(v)}
                options={sorted.map((r) => ({ value: r.id, label: `${r.date} · 共 ${r.data_points.length} 项` }))}
              />
            </div>
          </div>
        }
      >
        {typeFilter}
        <Tabs activeKey={tab} onChange={setTab} items={tabItems} size="small" />
      </Card>
    </div>
  )
}
