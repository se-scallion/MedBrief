// ===================== 待确认新项面板 =====================
// 展示本次识别中「字典未知」的指标（AI 新项），供人工确认后落库为自定义字段。
// 识别层已用 markNewItems 给无 standard_code 的项打 _isNew；此处聚合展示 + 提供
// 「确认并入库 / 提交时一并入库」两路。
//
// 2026-10-24 用户反馈两件事，本文件据此改：
//  ① 自动生成的 code 会跟着 OCR 名称一起脏（名称里混进单位/括号/误识字符 → 代码里出现多余文字），
//     而 code 一旦落库就是**主键**（趋势/同步/自定义字段匹配都认它）→ 故 **名称与代码都可手动改**，
//     代码实时校验（`custom:` 前缀 + [a-z0-9_-]），非法时禁止确认并给出原因。
//  ② 改动后的 code 要能带进「提交时一并入库」那条路 → 通过 onOverride 上抛，由 ImportFlow 在保存时
//     作为 overrides 传给 persistNewItems，避免"面板改了、提交时又按老名字重算一遍"。
import { useMemo, useState } from 'react'
import { collectNewItems, confirmNewItem, slugForField, normalizeCustomCode, isValidCustomCode } from '../utils/customFieldManager.js'

export default function NewItemsPanel({ points, overrides = {}, onOverride, onConfirmed }) {
  const items = useMemo(() => collectNewItems(points), [points])
  const [done, setDone] = useState({}) // 原名 -> 落库后的 code
  if (items.length === 0) return null

  const edited = (origName) => overrides[origName] || {}
  const codeOf = (it) => edited(it.name).code || slugForField(it.name, it.unit, it.ref)
  const nameOf = (it) => edited(it.name).name || it.name

  const handleConfirm = async (it) => {
    const code = codeOf(it)
    const name = nameOf(it)
    if (!isValidCustomCode(code) || !name.trim()) return
    const saved = await confirmNewItem({ name, unit: it.unit, ref: it.ref, code })
    setDone((d) => ({ ...d, [it.name]: saved || code }))
    onConfirmed && onConfirmed(saved || code, it)
  }

  return (
    <div className="card p-4 border-indigo-200 bg-indigo-50">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-indigo-800">待确认新项（{items.length}）</h3>
        <span className="text-[11px] text-indigo-500">字典未收录 · 名称与代码都可改 · 确认后下次自动复用</span>
      </div>
      <p className="text-[11px] text-indigo-600 mb-3 leading-relaxed">
        这些指标名称未被内置医学字典命中，可能是罕见 / 机构自定义项目。可直接确认入库，
        也可以先去掉名称里的多余文字（单位、括号、参考范围）再确认；代码一旦入库就是主键，建议保持简短唯一。
      </p>
      <ul className="space-y-2">
        {items.map((it) => {
          const code = codeOf(it)
          const name = nameOf(it)
          const codeOk = isValidCustomCode(code)
          const nameOk = !!name.trim()
          const confirmed = !!done[it.name]
          return (
            <li key={it.name} className="bg-white border border-indigo-100 rounded px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="text-[11px] text-slate-400 shrink-0">名称</span>
                  <input
                    type="text"
                    data-testid={`newitem-name-${it.name}`}
                    value={name}
                    disabled={confirmed}
                    onChange={(e) => onOverride && onOverride(it.name, { name: e.target.value })}
                    className="text-sm border border-slate-200 rounded px-2 py-1 min-w-0 flex-1 focus:border-brand-400 outline-none"
                  />
                </div>
                <span className="text-[11px] text-slate-500 font-mono shrink-0 tabular-nums">
                  {it.value}
                  {it.unit ? ` ${it.unit}` : ''}
                  {it.ref ? ` · ${it.ref}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                <span className="text-[11px] text-slate-400 shrink-0">代码</span>
                <input
                  type="text"
                  data-testid={`newitem-code-${it.name}`}
                  value={code}
                  disabled={confirmed}
                  onChange={(e) => onOverride && onOverride(it.name, { code: normalizeCustomCode(e.target.value) })}
                  spellCheck={false}
                  className={`text-xs font-mono border rounded px-2 py-1 min-w-0 flex-1 outline-none ${
                    codeOk ? 'border-slate-200 focus:border-brand-400' : 'border-red-300 bg-red-50 text-red-700'
                  }`}
                />
                <button
                  type="button"
                  disabled={confirmed}
                  onClick={() => onOverride && onOverride(it.name, { code: slugForField(it.name, it.unit, it.ref) })}
                  className="text-[11px] text-slate-500 hover:text-brand-700 underline shrink-0 cursor-pointer"
                  title="恢复成系统按名称自动生成的代码"
                >
                  重置
                </button>
                <button
                  type="button"
                  disabled={confirmed || !codeOk || !nameOk}
                  onClick={() => handleConfirm(it)}
                  className={
                    confirmed
                      ? 'text-[11px] text-emerald-600 border border-emerald-200 rounded px-2 py-1 bg-emerald-50 shrink-0'
                      : codeOk && nameOk
                      ? 'text-[11px] text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2 py-1 shrink-0 cursor-pointer'
                      : 'text-[11px] text-slate-400 bg-slate-100 rounded px-2 py-1 shrink-0 cursor-not-allowed'
                  }
                >
                  {confirmed ? '已入库' : '确认'}
                </button>
              </div>
              {!codeOk && (
                <p className="text-[11px] text-red-600 mt-1">
                  代码只能用字母、数字、下划线、连字符（合库主键，中文无法表达）
                </p>
              )}
              {!nameOk && <p className="text-[11px] text-red-600 mt-1">名称不能为空</p>}
              {confirmed && (
                <p className="text-[11px] text-emerald-600 mt-1 font-mono">已入库：{done[it.name]}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
