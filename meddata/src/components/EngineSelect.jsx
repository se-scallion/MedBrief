// ===================== 识别引擎下拉（带离线服务状态提示）=====================
// 四个引擎选择点（化验导入页 3 处、重新识别弹窗 2 处）共用一处实现，避免各写一遍漂移。
// 状态来自 useEngineHealth()：就绪不加后缀，启动中/离线把提示直接写进 option 文案
// （用户在下拉里就能看到「macOS Vision（本机）（服务未启动）」，不会选了才发现点不动）。
import { ENGINES } from '../utils/ocrEngines.js'
import { engineNote, engineOptionLabel } from '../utils/engineStatus.js'

export default function EngineSelect({
  value,
  onChange,
  disabled = false,
  health,
  className = '',
  showNote = false,
  title = '识别引擎',
}) {
  const note = showNote ? engineNote(value, health) : ''
  const sel = (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={title}
      className={`text-xs border border-slate-300 rounded px-2 py-1.5 bg-white ${className}`}
    >
      {Object.values(ENGINES).map((en) => (
        <option key={en.name} value={en.name} title={engineNote(en.name, health) || undefined}>
          {engineOptionLabel(en.name, health)}
        </option>
      ))}
    </select>
  )
  if (!showNote) return sel
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {sel}
      {note && <span className="text-[11px] text-amber-700 leading-tight">{note}</span>}
    </span>
  )
}
