// ===================== 检查报告 · 关键测量值编辑器 =====================
// 从 DocImportFlow 抽出（AI 主识别改造时该文件过大）：纯受控组件，增删改 + 可选轨切换器。
// onChange(measures) 之外不持有状态；「用户手改」的轨标记由调用方负责（docAi.markUserEdit）。
import { Input, Button } from 'antd'
import TrackSwitcher from './DocTrackSwitcher.jsx'

export default function DocMeasuresEditor({ measures = [], onChange, trackProps }) {
  const list = measures || []
  const update = (i, patch) => onChange(list.map((m, idx) => (idx === i ? { ...m, ...patch } : m)))
  return (
    <div className="space-y-2">
      {list.length > 0 && trackProps && (
        <div className="flex justify-end">
          <TrackSwitcher field="measures" {...trackProps} />
        </div>
      )}
      {list.map((m, i) => (
        <div key={i} className="flex gap-2 items-center" data-testid={`doc-measure-${i}`}>
          <Input
            size="small"
            className="flex-1"
            value={m.name}
            placeholder="项目"
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <Input
            size="small"
            className="w-24"
            value={m.value}
            placeholder="数值"
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Input
            size="small"
            className="w-20"
            value={m.unit}
            placeholder="单位"
            onChange={(e) => update(i, { unit: e.target.value })}
          />
          <Button
            size="small"
            danger
            type="text"
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
            title="删除"
          >
            删除
          </Button>
        </div>
      ))}
      <Button
        type="link"
        size="small"
        className="!px-0 !text-brand-600"
        data-testid="doc-measure-add"
        onClick={() => onChange([...list, { name: '', value: '', unit: '' }])}
      >
        ＋ 添加测量值
      </Button>
    </div>
  )
}
