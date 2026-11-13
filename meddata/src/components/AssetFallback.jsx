// 原件缺失/不可读时的统一占位块：一句事实文案 + 固定位置的操作按钮。
// 为什么不做成 hover tooltip：浮层随光标移动，里面的按钮"够不到"（AGENTS.md UI 铁律）。
// 文案与状态来自 utils/assetStatus.js，别在这里另写分档逻辑。
import { useRef, useState } from 'react'
import { Button } from 'antd'
import { ASSET_STATE } from '../utils/assetStatus.js'

export default function AssetFallback({ status, noun = '原件', onAttach, onRetry, extra = null }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  if (!status || status.state === ASSET_STATE.OK) return null
  const pick = () => inputRef.current && inputRef.current.click()
  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = '' // 允许连续选同一个文件
    if (!f || !onAttach) return
    setBusy(true)
    try {
      await onAttach(f)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <p className={`text-sm ${status.tone || 'text-slate-500'}`}>{status.text}</p>
      <div className="flex items-center gap-2">
        {status.canRetry && onRetry && (
          <Button size="small" onClick={onRetry}>
            重试
          </Button>
        )}
        {status.canAttach && onAttach && (
          <Button size="small" loading={busy} onClick={pick} data-testid="asset-attach">
            补传{noun}
          </Button>
        )}
        {extra}
      </div>
      <input ref={inputRef} type="file" className="hidden" onChange={onFile} />
    </div>
  )
}
