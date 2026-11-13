// 列表行徽标：一眼看出「这条没原件 / 原件缺失」，且不误报（离线时 hasRemoteBlob 返回 null → 不显示）。
// 文案与配色来自 utils/assetStatus.js，保持与详情页同一口径。
import { assetBadgeOf, assetRefOf } from '../utils/assetStatus.js'
import { hasRemoteBlob } from '../utils/apiStore.js'

export default function AssetBadge({ entity, noun = '原件' }) {
  const b = assetBadgeOf(entity, { hasBlob: hasRemoteBlob(assetRefOf(entity)), noun })
  if (!b.show) return null
  return (
    <span
      data-testid="asset-badge"
      className={`inline-flex shrink-0 items-center rounded border px-1 py-0 text-[10px] leading-4 ${b.cls}`}
      title={b.hint}
    >
      {b.text}
    </span>
  )
}
