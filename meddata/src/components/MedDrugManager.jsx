// ===================== 药品管理（隐式登记 + 药价维护） =====================
// 不新增药品表、不新增页面：药名候选由已有用药事件派生（drugRoster），这里做三件事——
// 1) 重命名 / 合并同药：把「泊那替尼片」等别名归拢到「泊那替尼」，历史事件自动合并为同一用药记录；
// 2) 药价维护：按药一行，点「改价」新增一条价格记录（含量/单位/体积/包装单位默认沿用上一条，可改）；
//    历史价格行可「编辑」修改；仅第一条可留空生效日（自起始），第二条起必填生效日（与第一条隔开）；
//    失效日自动 = 新价生效日的前一天 —— 支持正版 140 → 仿制 30 的按日变动；
// 3) 体温图开关：该药是否画进首页体温叠加图。
// 合并补丁由 planRename 纯函数产出；药价只调 store 的 addDrugPrice / deleteDrugPrice。

import { useMemo, useState } from 'react'
import DateInput from './DateInput.jsx'
import { Input, Button, Tag, App } from 'antd'
import dayjs from 'dayjs'
import { drugRoster, fmtD, localToday, normDrug, planRename } from '../utils/medCourses.js'
import { updateEvent, useStore, toggleTempDrug, addDrugPrice, deleteDrugPrice, updateDrugPrice } from '../data/store.js'
import { fmtMoney, priceExpiry, formatSpec } from '../utils/cost.js'

export default function MedDrugManager({ events, onNotify }) {
  const { modal } = App.useApp()
  const roster = useMemo(() => drugRoster(events), [events])
  const state = useStore()
  const prices = state.drugPrices || []
  const today = localToday()
  const ignored = useMemo(() => new Set(state.tempIrrelevantDrugs || []), [state.tempIrrelevantDrugs])
  const [open, setOpen] = useState(false)
  const [editingKey, setEditingKey] = useState(null)
  const [mode, setMode] = useState(null) // null | 'rename' | 'merge' | 'price'
  const [target, setTarget] = useState('')
  // 药价录入（结构化包装规格）：含量 + 含量单位 + 体积(选填) + 包装单位 + 单价 + 生效日
  const [pPrice, setPPrice] = useState('')
  const [pFrom, setPFrom] = useState(today)
  const [pContent, setPContent] = useState('')
  const [pContentUnit, setPContentUnit] = useState('mg')
  const [pVolume, setPVolume] = useState('')
  const [pPkgUnit, setPkgUnit] = useState('片')
  const [editingRecordId, setEditingRecordId] = useState(null) // 正在编辑的某条价格记录（null = 新增）
  const [pWholePack, setPWholePack] = useState(false) // 整支出库：每段用量向上取整到整只/整瓶（针剂余量弃用）

  if (!roster.length) return null

  const pricesOf = (key) =>
    prices
      .filter((p) => normDrug(p.drug) === normDrug(key))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))

  // 当前生效价（生效日 ≤ 今天中最晚的一条）
  const currentPrice = (key) => {
    const list = pricesOf(key).filter((p) => p.from <= today)
    return list.length ? list[list.length - 1] : null
  }

  // 重命名（改为新名）与合并（归到已有药名）底层都是把该药的事件改归属到新 key；
  // 区别只在交互措辞与默认值提示，逻辑统一走 planRename。
  const apply = (from, kind) => {
    const to = normDrug(target)
    if (!to || to === from) return
    const patches = planRename(events, from, to)
    if (!patches.length) return
    const verb = kind === 'rename' ? '改名为' : '合并到'
    modal.confirm({
      title: '确认操作',
      content: `将把 ${patches.length} 条记录由「${from}」${verb}「${to}」，历史事件会自动归拢为同一条用药记录。`,
      okText: '确认',
      cancelText: '取消',
      onOk: () => {
        patches.forEach((p) => updateEvent(p.id, p.patch))
        setEditingKey(null)
        setTarget('')
        setMode(null)
        onNotify && onNotify(`已${kind === 'rename' ? '改名' : '合并'}：${from} → ${to}（${patches.length} 条）`)
      },
    })
  }

  const cancelEdit = () => {
    setEditingKey(null)
    setTarget('')
    setMode(null)
  }

  const startPrice = (key) => {
    const mine = pricesOf(key)
    const last = mine.slice(-1)[0]
    setEditingKey(key)
    setMode('price')
    setEditingRecordId(null)
    // 第一条价格默认生效日为空（自起始）；第二条起默认今天（必填，与第一条隔开）
    setPFrom(mine.length === 0 ? '' : today)
    setPPrice('')
    setPContent(last && last.content != null ? String(last.content) : '')
    setPContentUnit((last && last.contentUnit) || 'mg')
    setPVolume(last && last.volume != null ? String(last.volume) : '')
    setPkgUnit((last && last.pkgUnit) || '片')
    setPWholePack(!!(last && last.wholePack)) // 沿用上一条，免得每次新增都重勾
  }

  // 编辑已有价格记录：把该条记录原值回填进表单
  const editPrice = (key, rec) => {
    setEditingKey(key)
    setMode('price')
    setEditingRecordId(rec.id)
    setPPrice(String(rec.price))
    setPFrom(rec.from || '')
    setPContent(rec.content != null ? String(rec.content) : '')
    setPContentUnit(rec.contentUnit || 'mg')
    setPVolume(rec.volume != null ? String(rec.volume) : '')
    setPkgUnit(rec.pkgUnit || '片')
    setPWholePack(!!rec.wholePack)
  }

  const submitPrice = (key) => {
    const price = Number(pPrice)
    if (!Number.isFinite(price) || price < 0) return
    const content = pContent === '' ? null : Number(pContent)
    const volume = pVolume === '' ? null : Number(pVolume)
    const row = {
      drug: normDrug(key),
      from: pFrom || '',
      content: Number.isFinite(content) ? content : null,
      contentUnit: pContentUnit || 'mg',
      volume: Number.isFinite(volume) ? volume : null,
      pkgUnit: pPkgUnit || '片',
      price,
      brand: '',
      wholePack: pWholePack,
    }
    if (editingRecordId) updateDrugPrice(editingRecordId, row)
    else addDrugPrice(row)
    setEditingKey(null)
    setMode(null)
    setEditingRecordId(null)
    onNotify && onNotify(`已${editingRecordId ? '改' : '记'} ${key} ${pFrom || '起'} ${fmtMoney(price)} 元/${pPkgUnit || '片'}`)
  }

  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-slate-500">
          药品管理 · 已登记 {roster.length} 个（重命名 / 合并 / 药价）
        </span>
        <Button type="link" size="small" className="!px-0" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </Button>
      </div>

      {open && (
        <ul className="mt-2 divide-y divide-slate-100">
          {roster.map((r) => {
            const pending = planRename(events, r.key, normDrug(target)).length
            const mine = pricesOf(r.key)
            const cur = currentPrice(r.key)
            // 价格录入校验：新增第一条可留空生效日（自起始），再新增需填生效日与第一条隔开；
            // 编辑已有记录允许保留空（基线「自起始」）；生效日不可与已有记录重复
            const others = mine.filter((p) => p.id !== editingRecordId)
            const isAdding = !editingRecordId
            const needDate = isAdding && others.length > 0
            const dupDate = pFrom && others.some((p) => p.from === pFrom)
            const priceValid = pPrice !== '' && Number.isFinite(Number(pPrice)) && Number(pPrice) >= 0
            const canSave = priceValid && !(needDate && !pFrom) && !dupDate
            return (
              <li key={r.key} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-slate-700">{r.key}</span>
                  <Tag color={r.stopped ? 'default' : 'cyan'} className="!mr-0">
                    {r.stopped ? '已停药' : '进行中'}
                  </Tag>
                  <span className="text-[11px] text-slate-400">{r.count} 条记录</span>
                  <span className="text-[11px] text-slate-400">
                    {fmtD(r.start)}
                    {r.end ? `~${fmtD(r.end)}` : ' 起'}
                  </span>
                  {r.current && (
                    <span className="text-[11px] text-slate-500">
                      {r.current.dose}
                      {r.current.unit}/日
                    </span>
                  )}
                  {/* 当前单价：未填则提示（未填价的药不计入花费） */}
                  <span className={`text-[11px] ${cur ? 'text-slate-600' : 'text-amber-600'}`}>
                    {cur ? `${fmtMoney(cur.price)} 元/${cur.pkgUnit || '片'}${formatSpec(cur) ? ` · ${formatSpec(cur)}` : ''}` : '未填价'}
                  </span>
                  <label
                    className="flex items-center gap-1 cursor-pointer select-none"
                    title="是否把该药画进首页体温叠加图（不影响其在疗程页的完整记录）"
                  >
                    <input type="checkbox" checked={!ignored.has(r.key)} onChange={() => toggleTempDrug(r.key)} />
                    <span className={ignored.has(r.key) ? 'text-slate-400' : 'text-orange-600 font-medium'}>体温图</span>
                  </label>
                  {editingKey !== r.key && (
                    <span className="ml-auto flex items-center gap-2">
                      <Button
                        type="link"
                        size="small"
                        className="!px-0 !text-brand-600"
                        title="记录新单价（换药 / 换价）：只填单价与生效日"
                        onClick={() => startPrice(r.key)}
                      >
                        改价
                      </Button>
                      <Button
                        type="link"
                        size="small"
                        className="!px-0 !text-brand-600"
                        onClick={() => {
                          setEditingKey(r.key)
                          setMode('rename')
                          setTarget('')
                        }}
                      >
                        重命名
                      </Button>
                      <Button
                        type="link"
                        size="small"
                        className="!px-0 !text-brand-600"
                        onClick={() => {
                          setEditingKey(r.key)
                          setMode('merge')
                          setTarget('')
                        }}
                      >
                        合并到
                      </Button>
                    </span>
                  )}
                </div>

                {/* 药价录入：极简两框（单价 + 生效日），规格默认沿用上一条 */}
                {editingKey === r.key && mode === 'price' && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div className="w-28">
                      <label className="label">新单价 元</label>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        autoFocus
                        value={pPrice}
                        onChange={(e) => setPPrice(e.target.value)}
                        onPressEnter={() => canSave && submitPrice(r.key)}
                      />
                    </div>
                    <div>
                      <label className="label">生效日{(isAdding && others.length > 0) ? '（必填）' : '（可空）'}</label>
                      <DateInput
                        className="w-36"
                        value={pFrom ? dayjs(pFrom) : null}
                        onChange={(d) => setPFrom(d ? d.format('YYYY-MM-DD') : '')}
                        allowClear
                      />
                    </div>
                    <div className="w-20">
                      <label className="label">含量</label>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={pContent}
                        placeholder="沿用"
                        onChange={(e) => setPContent(e.target.value)}
                        title="每包装有效成分含量；默认沿用上一条"
                      />
                    </div>
                    <div className="w-16">
                      <label className="label">单位</label>
                      <select className="input" value={pContentUnit} onChange={(e) => setPContentUnit(e.target.value)}>
                        <option value="mg">mg</option>
                        <option value="μg">µg</option>
                        <option value="g">g</option>
                      </select>
                    </div>
                    <div className="w-20">
                      <label className="label">体积 mL</label>
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={pVolume}
                        placeholder="选填"
                        onChange={(e) => setPVolume(e.target.value)}
                        title="针剂/输注药填（原液浓度=含量÷体积）；口服药留空"
                      />
                    </div>
                    <div className="w-16">
                      <label className="label">包装单位</label>
                      <select className="input" value={pPkgUnit} onChange={(e) => setPkgUnit(e.target.value)}>
                        {['片', '只', '支', '袋', '粒', '瓶', '盒', '贴', '包', '枚'].map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                    <label
                      className="flex items-center gap-1.5 text-xs text-slate-600 pb-2 cursor-pointer"
                      title="针剂/输注药勾选：整支出库、余量弃用，每段用量向上取整到整只/整瓶（贝林妥 90µg÷35µg/只 → 3 只而非 2.57 只）"
                    >
                      <input type="checkbox" checked={pWholePack} onChange={(e) => setPWholePack(e.target.checked)} />
                      整支出库
                    </label>
                    <Button
                      type="primary"
                      size="small"
                      disabled={!canSave}
                      onClick={() => submitPrice(r.key)}
                    >
                      保存
                    </Button>
                    <Button size="small" onClick={cancelEdit}>
                      取消
                    </Button>
                    {needDate && !pFrom && (
                      <span className="pb-1.5 text-[11px] text-red-500">第二条起需填生效日（与第一条默认空隔开）</span>
                    )}
                    {dupDate && <span className="pb-1.5 text-[11px] text-red-500">生效日与已有记录重复</span>}
                    <span className="pb-1.5 text-[11px] text-slate-400">
                      新增第一条可留空生效日（自起始）；再新增需填生效日与第一条隔开；可编辑已有记录。含量/单位/体积/包装单位默认沿用上一条，可改
                    </span>
                  </div>
                )}

                {/* 价格变动史（多行 = 按日变动） */}
                {mine.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {mine.map((p) => {
                      const expiry = priceExpiry(prices, p)
                      return (
                        <div key={p.id} className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                          <span className="font-mono text-slate-400">
                            {p.from} ~ {expiry || '至今'}
                          </span>
                          <span className="text-slate-700">{fmtMoney(p.price)} 元/{p.pkgUnit || '片'}</span>
                          {formatSpec(p) && <span className="text-slate-400">{formatSpec(p)}</span>}
                          {!formatSpec(p) && <span className="text-amber-600">缺规格</span>}
                          {p.brand && <span className="text-slate-400">· {p.brand}</span>}
                          {p.wholePack && <span className="text-brand-600 font-medium">· 整支出库</span>}
                          <button
                            type="button"
                            className="text-slate-400 hover:text-brand-600 cursor-pointer"
                            onClick={() => editPrice(r.key, p)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="ml-auto text-slate-400 hover:text-red-600 cursor-pointer"
                            onClick={() => {
                              deleteDrugPrice(p.id)
                              onNotify && onNotify(`已删除 ${r.key} ${p.from} 的价格`)
                            }}
                          >
                            删除
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}

                {editingKey === r.key && (mode === 'rename' || mode === 'merge') && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div className="min-w-[160px] flex-1">
                      <label className="label">{mode === 'rename' ? '改为药名' : '合并到已有药名'}</label>
                      <Input
                        value={target}
                        autoFocus
                        placeholder={mode === 'rename' ? '输入新名称，如：莫西沙星' : '选择或输入已有药名'}
                        onChange={(e) => setTarget(e.target.value)}
                        onPressEnter={() => apply(r.key, mode)}
                      />
                    </div>
                    {pending > 0 && <span className="pb-2 text-[11px] text-slate-500">影响 {pending} 条记录</span>}
                    <Button type="primary" size="small" disabled={!pending} onClick={() => apply(r.key, mode)}>
                      {mode === 'rename' ? '确认改名' : '确认合并'}
                    </Button>
                    <Button size="small" onClick={cancelEdit}>
                      取消
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
