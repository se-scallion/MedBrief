// ===================== 持续输注参数录入（四个框 → 自动折算每日剂量） =====================
// 只在「持续输注」模式下出现；口服药表单不受影响。折算公式见 medCourses.infusionDose：
//   配后浓度 = 原液浓度 × 抽取体积 ÷ 配后总体积；每日剂量 = 配后浓度 × 速率 × 24。
// 卡片与图表只展示折算后的每日剂量，这四个参数仅在此处与编辑框里可见。

import { infusionDose } from '../utils/medCourses.js'

const FIELDS = [
  { key: 'stock', label: '原液浓度 µg/mL', w: 'w-28' },
  { key: 'draw', label: '抽取 mL', w: 'w-20' },
  { key: 'bag', label: '配后 mL', w: 'w-20' },
  { key: 'rate', label: '速率 mL/h', w: 'w-20' },
]

export default function InfusionFields({ value, onChange, hint }) {
  const r = infusionDose(value)
  return (
    <div className="w-full rounded-lg bg-slate-50 p-2">
      <div className="flex flex-wrap gap-2 items-end">
        {FIELDS.map((fld) => (
          <div key={fld.key} className={fld.w}>
            <label className="label">{fld.label}</label>
            <input
              className="input text-center"
              type="number"
              min="0"
              step="any"
              value={value[fld.key] || ''}
              onChange={(e) => onChange({ ...value, [fld.key]: e.target.value })}
            />
            {fld.key === 'stock' && hint && (
              <p className="mt-0.5 text-[10px] leading-tight text-slate-400">{hint}</p>
            )}
          </div>
        ))}
        <div className="pb-2 text-[11px]">
          {r ? (
            <span className="text-slate-600">
              = <span className="font-mono font-medium text-slate-800">{r.daily} µg/日</span>（配后 {r.bagConc} µg/mL）
            </span>
          ) : (
            <span className="text-slate-400">填全四项自动折算每日剂量</span>
          )}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        换袋时记一条新剂量即可（改抽取量 / 总量 / 速率）；折算结果会写进每日剂量，图表与费用都按它算。
      </p>
    </div>
  )
}
