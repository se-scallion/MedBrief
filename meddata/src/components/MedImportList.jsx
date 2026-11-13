// ===================== 出院医嘱「识别到的用药」勾选列表 =====================
// 位置：CaseImportFlow 编辑态里「结构化字段」下方。
// 设计约束（务必遵守）：
//  1) 这里只做「预览 + 勾选 + 微调」，真正的病史数据写入由 CaseImportFlow 在保存时统一执行，
//     所以组件本身零副作用、不改 store。
//  2) 剂量判定不了的行（needConfirm）禁用勾选并在行内提示「待填」——绝不替用户猜剂量。
//  3) 状态徽标由 medExtract.rowAction 给出（新增 / 改量 / 重启 / 已在服），用户一眼知道发生了什么。

import { ACTION_LABEL } from '../utils/medExtract.js'

const ACTION_CLASS = {
  new: 'bg-brand-50 text-brand-700 border-brand-200',
  change: 'bg-amber-50 text-amber-700 border-amber-200',
  restart: 'bg-sky-50 text-sky-700 border-sky-200',
  same: 'bg-slate-50 text-slate-500 border-slate-200',
}

export default function MedImportList({ rows = [], roster = [], date = '', onChange }) {
  if (!rows.length) return null
  const checked = rows.filter((r) => r.checked).length

  return (
    <div className="rounded-lg border border-brand-100 bg-brand-50/40 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-brand-700">识别到的出院用药（勾选即写入用药记录，生效日 {date || '未定'}）</p>
        <p className="text-[11px] text-slate-500">
          已选 {checked} / {rows.length}
        </p>
      </div>

      <datalist id="med-roster">
        {roster.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const disabled = r.needConfirm || r.dose == null
          return (
            <div key={i} className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="checkbox"
                  className="accent-brand-600"
                  checked={!!r.checked}
                  disabled={disabled}
                  aria-label={`写入 ${r.name}`}
                  onChange={(e) => onChange(i, { checked: e.target.checked })}
                />
                <input
                  className="border border-slate-200 rounded px-2 py-1 text-sm w-52"
                  list="med-roster"
                  value={r.name}
                  onChange={(e) => onChange(i, { name: e.target.value })}
                />
                <input
                  type="number"
                  step="any"
                  className="border border-slate-200 rounded px-2 py-1 text-sm w-20 text-right font-mono"
                  value={r.dose == null ? '' : r.dose}
                  placeholder="剂量"
                  onChange={(e) => onChange(i, { dose: e.target.value === '' ? null : Number(e.target.value), needConfirm: e.target.value === '' })}
                />
                <input
                  className="border border-slate-200 rounded px-2 py-1 text-sm w-14"
                  value={r.unit || ''}
                  placeholder="单位"
                  onChange={(e) => onChange(i, { unit: e.target.value })}
                />
                <span className={`text-[11px] px-2 py-0.5 rounded border ${ACTION_CLASS[r.action] || ACTION_CLASS.new}`}>
                  {ACTION_LABEL[r.action] || r.action}
                </span>
                {r.matchedKey && r.matchedKey !== r.name && (
                  <span className="text-[11px] text-slate-400">
                    匹配已有：{r.matchedKey}
                    {r.action === 'change' && r.currentDose != null ? `（原 ${r.currentDose}${r.currentUnit || ''}）` : ''}
                  </span>
                )}
                {disabled && <span className="text-[11px] text-amber-600">用法识别不出剂量，填完才能勾选</span>}
              </div>
              {(r.spec || r.usage) && (
                <p className="mt-1 text-[11px] text-slate-400 pl-6 truncate">
                  原文：{[r.spec, r.usage].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
