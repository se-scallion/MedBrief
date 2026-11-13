// ===================== 「旧识别 vs 新识别」通用差异列表 =====================
// 为什么要单独抽出来：重新识别的对比弹窗会有三处使用（化验记录详情、检查报告详情、
// 出院记录详情 / 导入流程），若各写一遍两栏对比，样式与交互口径必然分裂。
// 本组件只做渲染，不含任何写入逻辑——「采用哪些、写不写」全部由调用方决定。
//
// 入参 items: [{ key, label, old, new, differs }]
//   - differs 为 true → 橙色两栏（旧灰 / 新绿）；否则单栏展示，避免整屏无意义重复。
// 可选入参（给调用方提供「逐项采用」能力；不传则纯展示）：
//   - selected: Set<string> 已勾选采用新值的 key 集合
//   - onToggle(key): 勾选/取消某字段
//   只有 differs 的行可勾选（无变化 → 采用不采用结果一样，勾选纯属噪声）。

export default function DiffListView({ items = [], selected, onToggle }) {
  const selectable = typeof onToggle === 'function'
  const isOn = (key) => !!(selected && selected.has && selected.has(key))

  return (
    <div className="space-y-3">
      {items.map((d) => {
        if (!d.differs) {
          return (
            <div className="card p-3" key={d.key}>
              <div className="text-[11px] text-slate-500 mb-1 flex items-center gap-2">
                {d.label}
                <span className="text-slate-300">无变化</span>
              </div>
              <pre className="text-xs text-slate-500 whitespace-pre-wrap break-words font-sans leading-relaxed">
                {d.old || '（空）'}
              </pre>
            </div>
          )
        }
        const on = selectable && isOn(d.key)
        return (
          <div
            className={`card p-3 ${on ? 'border-emerald-400 ring-1 ring-emerald-200 bg-emerald-50/40' : 'border-orange-300 bg-orange-50'}`}
            key={d.key}
          >
            <div className="text-[11px] mb-1 flex items-center gap-2">
              <span className={on ? 'text-emerald-700' : 'text-orange-700'}>{d.label}</span>
              <span className="px-1.5 py-0.5 rounded bg-orange-200 text-orange-800 text-[10px]">有变化</span>
              {on && <span className="px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-800 text-[10px]">将采用新值</span>}
              {selectable && (
                <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none text-[11px] text-slate-600">
                  <input
                    type="checkbox"
                    className="accent-emerald-600"
                    aria-label={`采用${d.label}新值`}
                    checked={on}
                    onChange={() => onToggle(d.key)}
                  />
                  采用新值
                </label>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] text-slate-400 mb-0.5">旧识别</div>
                <pre className="text-xs text-slate-500 whitespace-pre-wrap break-words font-sans leading-relaxed bg-white rounded p-2 border border-slate-200 max-h-56 overflow-auto">
                  {d.old || '（空）'}
                </pre>
              </div>
              <div>
                <div className="text-[10px] text-emerald-600 mb-0.5">新识别</div>
                <pre className="text-xs text-slate-900 whitespace-pre-wrap break-words font-sans leading-relaxed bg-white rounded p-2 border border-emerald-200 max-h-56 overflow-auto">
                  {d.new || '（空）'}
                </pre>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
