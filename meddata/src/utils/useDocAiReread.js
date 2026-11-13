// ===================== 「AI 重读」公共流程（详情页：检查报告 / 病历文书共用）=====================
// 为什么抽成 hook：检查报告详情（DocDetail）与病历文书详情（CaseDetail）要走**同一条** AI 链路——
// 取原件 → （图片才）压缩给模型 → 提交任务 → 轮询 → 得到逐字段结果。两处各写一遍必然漂移
// （轮询超时/限流文案/任务中心登记任何一处改动都会漏）。本 hook 只管「跑 + 状态」，
// 隐私同意门（CloudConsentModal）与对比弹窗留由调用方决定，便于两个详情页各自排版。
//
// 约定：结果只在调用方弹窗里逐字段采用，本 hook 绝不写库。

import { useEffect, useRef, useState } from 'react'
import { getDocFile, getDocText, saveDocFile } from './docFileStore.js'
import { postDocRead } from './classify.js'
import { docImageForAi } from './docImage.js'
import { pollAiTask, fetchTaskStatus, fetchTaskResult, listAllTasks, upsertTask, patchTask, postTaskReview } from './docTasks.js'
import { pickRecoverTask, RECOVER_MATCH_LABELS } from './docAi.js'

// 读图重读的实测耗时：**随引擎大幅变化**——本机 7863 网关约 30–60 秒（2026-10-21 实测 32s），
// 走云端 dsh 时曾 252 秒（2026-10-20 实测 20:29 提交 → 20:34 出结果）。故预算按最坏情况给。
// 原先沿用 5 分钟的轮询预算，正好卡在临界点上——任务其实成功了，前端却报「未成功」。
// 故预算放宽到 15 分钟；超时也不再当失败（后端仍在跑，结果可用「载入后台结果」取回）。
const REREAD_TIMEOUT_MS = 900_000

export function useDocAiReread({ doc, fileId }) {
  const [running, setRunning] = useState(false)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [ms, setMs] = useState(0)
  const [mode, setMode] = useState('')
  // 超时后仍留在后台跑的任务 id：供「载入后台结果」取回（任务没丢，绝不能报成失败）
  const [pendingId, setPendingId] = useState('')
  const [loadingPending, setLoadingPending] = useState(false)
  // 本次结果是「上次已跑完但没应用」的历史结果（不是刚读的），UI 要明示并提供重新读图
  const [fromCache, setFromCache] = useState(false)
  // 复用结果是怎么匹配上的（任务号 / 原件字节哈希 / 文件名弱匹配）——弱匹配必须让人核对
  const [cacheNote, setCacheNote] = useState('')
  const timerRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (abortRef.current) abortRef.current.abort()
    },
    []
  )

  const reset = () => {
    setRes(null)
    setErr('')
    setMs(0)
    setPendingId('')
    setFromCache(false)
    setCacheNote('')
  }

  // 点「AI 重读」时先捡上次已跑完但没应用的结果：读图要数十秒到数分钟 + agent 费用，
  // 不能让用户因为「上一次超时了」把同样的钱再花一遍。
  const recover = async () => {
    if (!doc || !doc.file || !doc.file.name) return false
    const all = await listAllTasks()
    // 命中优先级：本档记录绑定的任务号 > 原件字节哈希 > 文件名（弱匹配，UI 明示）。
    // 原实现只看文件名 —— 同名不同图会静默接上别人的结果（真实语料里同名任务 6 组）。
    const hit = pickRecoverTask(all, {
      taskId: (doc.ai && doc.ai.task_id) || '',
      sha256: (doc.file && doc.file.sha256) || '',
      fileName: doc.file.name,
    })
    if (!hit) return false
    const r = await fetchTaskResult(hit.task.id)
    if (!r || (r.state && r.state !== 'done')) return false
    setRes(r)
    setErr('')
    setPendingId('')
    setFromCache(true)
    setCacheNote(
      `复用已完成任务 #${String(hit.task.id).slice(-6)}（按${RECOVER_MATCH_LABELS[hit.matchedBy] || hit.matchedBy}匹配，未重复计费）`
    )
    return true
  }

  // 超时后手动取回后台结果：完成则直接进对比弹窗（不重跑、不花钱）
  const loadPending = async () => {
    if (!pendingId) return false
    setLoadingPending(true)
    try {
      const st = await fetchTaskStatus(pendingId)
      if (st.state !== 'done') {
        setErr(
          st.state === 'failed' || st.state === 'rate_limited'
            ? st.message || 'AI 任务失败（可到「AI 任务」查看原因并重试）'
            : 'AI 仍在读图，稍后再点一次「载入后台结果」'
        )
        return false
      }
      const r = await fetchTaskResult(pendingId)
      if (!r || r.state !== 'done') {
        setErr('结果文件还没落盘，稍后再点一次「载入后台结果」')
        return false
      }
      setRes(r)
      setErr('')
      setPendingId('')
      return true
    } finally {
      setLoadingPending(false)
    }
  }

  // 应用后把任务标记为已核对，任务中心的「待核对」才不会一直挂着。
  // 同时回写服务端（2026-10-25）：否则换设备后既显示「待核对」，也无法从任务跳回这条归档。
  const markApplied = () => {
    if (res && res.id) postTaskReview(res.id, (doc && doc.id) || '')
  }

  const run = async () => {
    reset()
    if (!fileId) {
      setErr('该归档未保留原件，无法 AI 重读')
      return
    }
    const blob = await getDocFile(fileId).catch(() => null)
    if (!blob) {
      setErr('原件读取失败，无法 AI 重读')
      return
    }
    const fileName = (doc.file && doc.file.name) || `d_${doc.id}.jpg`
    const f = new File([blob], fileName, { type: (doc.file && doc.file.mime) || blob.type || 'application/octet-stream' })
    const isImage = (f.type || '').startsWith('image/')
    // 扫描件（文本来自 OCR）一律读图；只有真·PDF 文字层才走 doc-text（见 docAi.docReadModeFor）
    const readMode = isImage || doc.is_scanned ? 'doc' : 'doc-text'
    const id = `docread-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const rawText = doc.raw_text || (await getDocText(doc.id).catch(() => '')) || ''
    setMode(readMode)
    setRunning(true)
    const t0 = Date.now()
    setMs(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setMs(Date.now() - t0), 1000)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      let image = ''
      if (readMode === 'doc') image = (await docImageForAi(f)).dataUrl
      upsertTask({
        id,
        kind: 'doc',
        state: 'running',
        mode: readMode,
        fileName,
        docType: doc.doc_type || '',
        startedAt: new Date(t0).toISOString(),
        reviewed: false,
      })
      // 原件 blob 引用：这条任务的源文件就是该归档的原件（doc.file.id），直接带上，不再复制一份
      const blobId = (doc.file && doc.file.id) || (await saveDocFile(f).catch(() => ''))
      const posted = await postDocRead({
        id,
        mode: readMode,
        image,
        text: rawText,
        reportType: doc.doc_type || '',
        fileName,
        // 溯源锚（2026-10-25）：任务 ↔ 归档按原件字节哈希对齐，不再依赖文件名
        sha256: (doc.file && doc.file.sha256) || '',
        origin: 'reread',
        blobId,
      })
      if (posted && posted.skipped) {
        setErr('AI 链路已关闭（顶栏「AI 反馈」面板可切回 oneshot / off）')
        return
      }
      if (!posted || !posted.persisted) {
        setErr('AI 服务未连接（需 pnpm run dev:full 起 8008）')
        return
      }
      const done = await pollAiTask(id, { signal: ac.signal, timeoutMs: REREAD_TIMEOUT_MS, intervalMs: 3000 })
      if (done.state === 'aborted') return
      if (done.state === 'timeout') {
        // 不是失败：后端还在跑，把任务挂起来让用户一键取回
        setPendingId(id)
        setErr(`AI 仍在后台运行（已等 ${Math.round((Date.now() - t0) / 60000)} 分钟）。任务没有丢：点「载入后台结果」取回，或关闭弹窗后到「AI 任务」查看。`)
        return
      }
      if (done.state === 'rate_limited') {
        setErr(done.message || 'AI 接口限流中，稍后可到「AI 任务」重试')
        return
      }
      if (done.state !== 'done' || (done.status && done.status !== 'done')) {
        setErr('AI 重读未成功（可到「AI 任务」里重试）')
        return
      }
      setRes(done)
      patchTask(id, { reviewed: false })
    } catch (e) {
      setErr('AI 重读异常：' + ((e && e.message) || String(e)))
    } finally {
      setRunning(false)
      if (timerRef.current) clearInterval(timerRef.current)
      abortRef.current = null
    }
  }

  return {
    running,
    res,
    err,
    ms,
    mode,
    run,
    reset,
    recover,
    fromCache,
    cacheNote,
    pendingId,
    loadPending,
    loadingPending,
    markApplied,
  }
}
