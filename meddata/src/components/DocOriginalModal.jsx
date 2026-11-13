// ===================== 图文报告 · 只看原件（列表行「原件」直达） =====================
// 为什么单独做一个弹层，而不是复用 DocDetail：
//   DocDetail 是「左原件 + 右识别内容」的两栏详情，对应行上的「查看报告」；
//   行上「原件」要的是**一眼看图**（核对手抄、比对原图），右栏文字反成干扰。
// 两者并存是用户口径（2026-10-30）：图文报告同样有文字录入，原件与识别内容都必须可达。
// 原件取不到时按 assetStatus 三态说事实，不把"连不上"渲染成"丢了"（唯一口径见 utils/assetStatus.js）。

import { useEffect, useState } from 'react'
import { App, Modal, Tag } from 'antd'
import { getDocFile } from '../utils/docFileStore.js'
import { getConfig, getStatus } from '../utils/apiStore.js'
import { assetStatusOf } from '../utils/assetStatus.js'
import { attachDocFile } from '../utils/assetAttach.js'
import { KIND_LABELS } from '../data/docKinds.js'
import DocSourceViewer from './DocSourceViewer.jsx'
import AssetFallback from './AssetFallback.jsx'

export default function DocOriginalModal({ doc, onClose }) {
  const { modal } = App.useApp()
  const [file, setFile] = useState(null)
  const [probed, setProbed] = useState(false) // 探测结束才允许下"未找到"的结论
  const [reloadTick, setReloadTick] = useState(0)
  const fileId = doc && doc.file && doc.file.id
  const fileName = (doc && doc.file && doc.file.name) || `${(doc && doc.date) || '原件'}`

  useEffect(() => {
    let alive = true
    setFile(null)
    setProbed(false)
    ;(async () => {
      try {
        const blob = await getDocFile(fileId)
        if (!alive) return
        // DocSourceViewer 吃 File（用它自带的 name/type 渲染头部与图片/PDF 分支）
        if (blob) setFile(new File([blob], fileName, { type: blob.type || (doc.file && doc.file.mime) || '' }))
      } catch (e) {
        console.error('原件读取失败', e)
      } finally {
        if (alive) setProbed(true)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, reloadTick])

  const status = assetStatusOf(doc, {
    noun: '原件',
    manualLabel: '手动录入',
    hasBlob: probed ? !!file : null,
    online: getStatus().online,
    syncEnabled: getConfig().enabled,
  })

  const attach = async (f) => {
    try {
      await attachDocFile(doc, f)
      setReloadTick((n) => n + 1)
    } catch (e) {
      modal.error({ title: '补传原件失败', content: String((e && e.message) || e) })
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width="96%"
      style={{ maxWidth: 1080, top: 20 }}
      title={
        <div className="flex items-center gap-3">
          <Tag>{KIND_LABELS[doc.kind] || '原件'}</Tag>
          <span className="text-base font-semibold text-slate-800">{doc.title || fileName}</span>
          {doc.date && <span className="text-xs text-slate-400 font-mono">{doc.date}</span>}
        </div>
      }
      styles={{ body: { padding: 0 } }}
    >
      <div className="h-[76vh] flex flex-col">
        {file ? (
          <DocSourceViewer file={file} downloadName={fileName} className="flex-1" />
        ) : !probed ? (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400">原件读取中…</div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <AssetFallback status={status} noun="原件" onAttach={attach} onRetry={() => setReloadTick((n) => n + 1)} />
          </div>
        )}
      </div>
    </Modal>
  )
}
