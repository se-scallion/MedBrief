// ===================== 日期输入（DatePicker 包装：手输即时同步） =====================
// 为什么需要（Bug 225）：antd DatePicker 的「手输文本」只在回车 / 失焦时才提交给 onChange，
// 而点「保存」这一下同时触发 blur 提交与 click 保存 —— click 的 handler 闭包里读到的还是提交前的
// 空值 → 手输的日期被静默丢弃（还照样弹「已更新」）。实测：段编辑手输「输完日」+ 立刻点保存，
// end 落库为 null；先失焦再点保存 / 按回车 / 从面板选日则正常（scripts/verify-med-date-save-ui.mjs）。
//
// 修法：把内部 input 的文本在**每次敲键时就**推给 onChange（与普通受控输入同语义），
// 于是用户点保存时 state 早已是最新值，与 antd 内部的提交时机彻底解耦。
// 用 display:contents 包一层，避免给各处 flex/栅格布局引入新盒子。
import { DatePicker } from 'antd'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'

dayjs.extend(customParseFormat)

const ISO = 'YYYY-MM-DD'

const asText = (v) => (v && typeof v.format === 'function' ? v.format(ISO) : String(v || ''))

export default function DateInput({ onChange, ...rest }) {
  const onInput = (e) => {
    const t = String((e && e.target && e.target.value) || '').trim()
    if (!t) {
      // 用户清空输入框 → 同步为空（否则保存会沿用上一次的日期）
      if (asText(rest.value)) onChange?.(null, '')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return // 半截输入（2026-11-0）不推送，等antd 自己处理
    if (asText(rest.value) === t) return // 值没变，不重复推送（避免与面板选择互相触发）
    const d = dayjs(t, ISO, true)
    if (d.isValid()) onChange?.(d, t)
  }
  return (
    <span className="contents" onInput={onInput}>
      <DatePicker {...rest} onChange={onChange} />
    </span>
  )
}
