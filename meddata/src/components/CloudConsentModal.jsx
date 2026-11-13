// ===================== 云端/AI 识别 · 隐私免责确认框 =====================
// 多引擎识别（评审加固）：MinerU 云端与 AI 精读会把报告原图上传到第三方服务，
// 首次触发时弹本确认框；用户同意状态记 localStorage（meddata_cloud_ocr_consent），
// 之后不再弹；支持撤销（设置里清 key 即可，或在确认框勾选「不再提示」语义由 key 存在性表达）。
// 外壳照项目既有应用内确认框范式（点击遮罩关闭、固定浮层、绝不 hover-follow）。

import { useState } from 'react'
import { useEscClose } from '../utils/overlay.js'

const CONSENT_KEY = 'meddata_cloud_ocr_consent'

// 读取同意状态：{ mineru: bool, ai: bool }（缺省 false = 未同意，会再弹）
export function getCloudConsent() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONSENT_KEY) || '{}')
    return { mineru: !!raw.mineru, ai: !!raw.ai }
  } catch {
    return { mineru: false, ai: false }
  }
}

export function setCloudConsent(engine, ok) {
  const next = { ...getCloudConsent(), [engine]: !!ok }
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(next))
  } catch {
    /* localStorage 不可用时静默——下次会再弹确认框（安全侧默认） */
  }
  return next
}

// 是否已同意该引擎的云端上传
export function hasCloudConsent(engine) {
  return !!getCloudConsent()[engine]
}

const ENGINE_NOTICES = {
  mineru: {
    title: '使用 MinerU 云端识别？',
    message:
      '该方式会把报告原图上传至 MinerU 云端服务（mineru.net）进行识别，识别质量最好（评测第一），但需注意：\n\n· 原图中的姓名、就诊号等个人信息均会随图上传\n· 云端为免费接口，无可用性承诺（SLA），单张约 30 秒\n\n请确认已知晓并接受后再继续。',
  },
  ai: {
    title: '使用 AI 识别？',
    message:
      '该方式会把报告原图交给本机 AI 识别服务读取转录（图片仅在本机与 AI 服务间传输），单次约 30–70 秒；识别结果会作为当前生效值填入草稿，仍可逐字段切回本地识别结果核对。\n\n请确认已知晓后再继续。',
  },
}

export default function CloudConsentModal({ engine, onOk, onClose }) {
  const notice = ENGINE_NOTICES[engine] || { title: '使用云端识别？', message: '原图将上传至第三方服务。' }
  const [remember, setRemember] = useState(true)

  // Esc 关闭：走统一栈（本框是在报告/重识别弹层里弹出来的，栈顶＝本框，
  // 一次 Esc 只关确认框，不会把底下的详情页一起关掉）
  useEscClose(onClose)

  return (
    <div
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-slate-900/50"
      onClick={onClose}
    >
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 p-5 w-[26rem] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-slate-800">{notice.title}</p>
        <p className="mt-2 text-xs text-slate-500 whitespace-pre-line leading-relaxed">{notice.message}</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-sky-500" />
          记住我的选择，之后不再提示
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost text-xs" onClick={onClose}>
            取消
          </button>
          <button
            className="text-xs px-3 py-1.5 rounded bg-amber-500 text-white hover:bg-amber-600 font-medium"
            onClick={() => {
              if (remember) setCloudConsent(engine, true)
              onOk && onOk()
            }}
          >
            已知晓，继续识别
          </button>
        </div>
      </div>
    </div>
  )
}
