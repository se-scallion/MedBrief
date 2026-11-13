// 仅开发模式（import.meta.env.DEV）生效的本地控制桥。
// 作用：让本机命令行能直接修改浏览器内的 MedData 数据，无需手动操作。
// 链路：Node 脚本/命令行 → POST http://localhost:5173/__devbridge → App 轮询到 → 写入 store（IndexedDB） → UI 自动刷新。
// 生产构建不会包含本文件（vite 配置中插件也仅 dev 生效），不会对外暴露任何端口。
import { useEffect } from 'react'
import { updateDoc, getState, addDoc, addEvent, updateEvent, deleteEvent, writeRecord, addStay } from './data/store'
import { getRecordImage, getDocFile, saveDocFile } from './utils/docFileStore.js'
import { runLocalBest, runLocalBestSliced, runLocalBestParallel, getLastOcrRoute, SLICE_POLICY, ocrImageToText } from './utils/ocr.js'
import { reRecognizeDoc, CURRENT_RECOGNITION_VERSION } from './utils/reRecognize.js'
import { computeStatus } from './utils/normalize.js'
import { FIELD_BY_CODE } from './data/dictionary.js'
import { buildMedEvent, nextDay, normDrug } from './utils/medCourses.js'

// Blob -> base64 dataURL（浏览器内执行）
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

// base64 dataURL -> Blob（addDoc 带原件时用：命令行推 dataUrl，浏览器内落成 IndexedDB 原件）
function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl || ''))
  if (!m) throw new Error('bad dataUrl')
  const mime = m[1] || 'application/octet-stream'
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3])
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// 量图高（浏览器内执行），供 ocrBench 判断是否触发切片路径
function measureHeight(dataUrl) {
  return new Promise((resolve) => {
    const im = new Image()
    im.onload = () => resolve(im.naturalHeight)
    im.onerror = () => resolve(0)
    im.src = dataUrl
  })
}

const ENABLED = import.meta.env.DEV

// 支持的操作（op）：
//   { type: 'patchDoc', id?, match?: {字段:值}, patch: {字段:值} }
//     —— 按 id 或 match（与 docs 数组元素逐字段相等匹配）定位报告，应用 patch。
//   { type: 'addDoc', doc: {date,kind,doc_type,title,fields,category?,raw_text?...}, file?: {name,type,dataUrl} }
//     —— 新增一份病历文书 / 检查报告（走 store.addDoc 同一写入收口）。
//        file.dataUrl 存在时落成 IndexedDB 原件；无文件则标 no_file（手动录入形态）。
//        doc.id 幂等：同 id 已存在则直接返回已存在记录，不重复新增。
export function useDevBridge() {
  useEffect(() => {
    if (!ENABLED) return
    let alive = true

    const apply = async (ops) => {
      const results = []
      // 直接读 store 实时内存（UI 所用的同一份数据），避免 localStorage 序列化时机不一致导致 docs 为空
      const liveDocs = getState().docs || []
      for (const op of ops || []) {
        if (op.type === 'diagnose') {
          try {
            const st = getState()
            const lsObj = getState() // 改造后结构化状态在 IndexedDB，getState() 即内存态，不再读 localStorage
            // 直接用 localStorage 真值（避免 HMR 重载导致内存态尚未加载时的竞态）
            const lsRecords = Array.isArray(lsObj.records) ? lsObj.records : st.records || []
            let lsDocsLen = -1
            try {
              lsDocsLen = (lsObj.docs || []).length
            } catch {
              /* ignore */
            }
            results.push({
              op,
              stateKeys: Object.keys(st),
              memRecords: (st.records || []).length,
              lsRecords: lsRecords.length,
              docsLen: (st.docs || []).length,
              titles: (st.docs || []).map((d) => d.title),
              docs: (st.docs || []).map((d) => ({ id: d.id, date: d.date, doc_type: d.doc_type, title: d.title, part: d.part })),
              records: lsRecords.map((r) => ({
                id: r.id,
                date: r.date,
                report_type: r.report_type,
                created_at: r.created_at,
                checked_at: r.checked_at || '',
                received_at: r.received_at || '',
                reported_at: r.reported_at || '',
                data_points: (r.data_points || []).map((p) => ({
                  standard_code: p.standard_code,
                  original_name: p.original_name,
                  value: p.value,
                  unit: p.unit,
                  ref_range: p.ref_range,
                  arrow: p.arrow,
                  status: p.status,
                })),
              })),
              lsLen: JSON.stringify(st).length,
              lsDocsLen,
              href: typeof location !== 'undefined' ? location.href : '',
            })
          } catch (e) {
            results.push({ op, error: String(e) })
          }
          continue
        }
        if (op.type === 'dumpImages') {
          try {
            const lsObj = getState() // 改造后结构化状态在 IndexedDB，getState() 即内存态，不再读 localStorage
            const lsRecords = Array.isArray(lsObj.records) ? lsObj.records : getState().records || []
            const ids = op.ids || 'ALL'
            const out = lsRecords
              .filter((r) => ids === 'ALL' || (Array.isArray(ids) && ids.includes(r.id)))
              .map((r) => ({
                id: r.id,
                date: r.date,
                report_type: r.report_type,
                hasImage: !!r.image,
                original_image_id: r.original_image_id || null,
                keys: Object.keys(r),
              }))
            results.push({ op, records: out })
          } catch (e) {
            results.push({ op, error: String(e) })
          }
          continue
        }
        if (op.type === 'getImage') {
          try {
            const lsObj = getState() // 改造后结构化状态在 IndexedDB，getState() 即内存态，不再读 localStorage
            const lsRecords = Array.isArray(lsObj.records) ? lsObj.records : getState().records || []
            const ids = Array.isArray(op.ids) ? op.ids : []
            const out = []
            for (const r of lsRecords) {
              if (!ids.includes(r.id)) continue
              const oid = r.original_image_id
              let dataUrl = null
              let fetchStatus = 'no-original'
              if (oid) {
                fetchStatus = 'has-original'
                try {
                  const blob = await Promise.race([
                    getRecordImage(oid),
                    new Promise((res) => setTimeout(() => res('__timeout__'), 6000)),
                  ])
                  if (blob && blob !== '__timeout__') {
                    dataUrl = await Promise.race([
                      blobToDataUrl(blob),
                      new Promise((res) => setTimeout(() => res(null), 6000)),
                    ])
                    fetchStatus = dataUrl ? 'ok' : 'blob-to-dataurl-failed'
                  } else if (blob === '__timeout__') {
                    fetchStatus = 'getRecordImage-timeout'
                  } else {
                    fetchStatus = 'original-not-found'
                  }
                } catch (e) {
                  fetchStatus = 'error:' + String(e)
                }
              }
              out.push({ id: r.id, date: r.date, report_type: r.report_type, hasOriginal: !!oid, fetchStatus, image: dataUrl })
            }
            results.push({ op, records: out })
          } catch (e) {
            results.push({ op, error: String(e) })
          }
          continue
        }
        if (op.type === 'dumpAll') {
          try {
            const all = {}
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              if (k) all[k] = localStorage.getItem(k)
            }
            results.push({ op, keys: Object.keys(all), bytes: JSON.stringify(all).length, data: all })
          } catch (e) {
            results.push({ op, error: String(e) })
          }
          continue
        }
        if (op.type === 'dumpState') {
          try {
            results.push({ op, data: getState() })
          } catch (e) {
            results.push({ op, error: String(e) })
          }
          continue
        }
        if (op.type === 'dumpDocFiles') {
          try {
            const lsObj = getState() // 改造后结构化状态在 IndexedDB，getState() 即内存态，不再读 localStorage
            const docs = Array.isArray(lsObj.docs) ? lsObj.docs : getState().docs || []
            const out = []
            for (const d of docs) {
              const fid = d.file && d.file.id
              if (!fid) {
                out.push({ id: d.id, title: d.title, hasFile: false })
                continue
              }
              try {
                const blob = await getDocFile(fid)
                if (!blob) {
                  out.push({ id: d.id, title: d.title, hasFile: true, status: 'not-found' })
                  continue
                }
                const dataUrl = await blobToDataUrl(blob)
                out.push({ id: d.id, title: d.title, name: d.file.name, type: blob.type || d.file.type, hasFile: true, status: 'ok', image: dataUrl })
              } catch (e) {
                out.push({ id: d.id, title: d.title, hasFile: true, status: 'error:' + String(e) })
              }
            }
            results.push({ op, docs: out })
          } catch (e) {
            results.push({ op, error: String(e) })
          }
          continue
        }
        if (op.type === 'patchDoc') {
          try {
            const doc = liveDocs.find(
              (d) =>
                (op.id && d.id === op.id) ||
                (op.match && Object.entries(op.match).every(([k, v]) => d[k] === v))
            )
            if (!doc) {
              results.push({ op, matched: false, reason: 'no-match', titles: liveDocs.map((d) => d.title) })
              continue
            }
            if (op.patch) updateDoc(doc.id, op.patch)
            results.push({ op, matched: true, id: doc.id, before: { title: doc.title, part: doc.part }, patch: op.patch })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'addDoc') {
          try {
            const d = { ...(op.doc || {}) }
            if (!d.date || !d.kind) {
              results.push({ op, matched: false, reason: 'missing-fields', need: ['date', 'kind'] })
              continue
            }
            // 幂等：同 id 已存在 → 直接回报已存在，不重复新增（重推同一批 op 安全）
            const existed = d.id && (getState().docs || []).find((x) => x.id === d.id)
            if (existed) {
              results.push({ op, matched: true, id: existed.id, existed: true })
              continue
            }
            let file = null
            if (op.file && op.file.dataUrl) {
              const blob = dataUrlToBlob(op.file.dataUrl)
              const fileId = await saveDocFile(blob)
              file = {
                id: fileId,
                name: op.file.name || `doc-${d.date}.jpg`,
                size: op.file.size || blob.size,
                mime: op.file.type || blob.type || 'application/octet-stream',
              }
            }
            delete d.file
            const newId = addDoc({ ...d, ...(file ? { file } : { no_file: true }) })
            // 写后读回：以 store 真值为准，不看入参（对应「写必有读回验证」铁律）
            const saved = (getState().docs || []).find((x) => x.id === newId) || null
            results.push({
              op,
              matched: !!saved,
              id: newId,
              saved: saved
                ? {
                    date: saved.date,
                    kind: saved.kind,
                    doc_type: saved.doc_type,
                    title: saved.title,
                    category: saved.category || '',
                    fields: saved.fields || {},
                    file: saved.file ? saved.file.name : null,
                    has_text: !!saved.has_text,
                  }
                : null,
            })
            if (!saved) results[results.length - 1].reason = 'read-back-mismatch'
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
          continue
        }
        if (op.type === 'appendPoints') {
          try {
            const liveRecords = getState().records || []
            const rec = liveRecords.find(
              (r) =>
                (op.id && r.id === op.id) ||
                (op.match && Object.entries(op.match).every(([k, v]) => r[k] === v))
            )
            if (!rec) {
              results.push({ op, matched: false, reason: 'no-match', ids: liveRecords.map((d) => d.id) })
              continue
            }
            const existing = rec.data_points || []
            const pts = (op.points || []).map((p) => {
              const f = FIELD_BY_CODE[p.standard_code]
              const value = String(p.value)
              const ref = p.ref_range || (f ? f.ref : '')
              const unit = p.unit || (f ? f.unit : '')
              const status = computeStatus(p.standard_code, value, ref, p.arrow || '', unit)
              return {
                standard_code: p.standard_code,
                original_name: p.original_name || (f ? f.name : ''),
                value,
                unit,
                ref_range: ref,
                arrow: p.arrow || '',
                status,
                _source: 'devbridge-append',
              }
            })
            writeRecord({ id: rec.id, patch: { data_points: [...existing, ...pts] }, source: 'devbridge' })
            results.push({
              op,
              matched: true,
              id: rec.id,
              appended: pts.map((p) => ({ code: p.standard_code, value: p.value, status: p.status })),
            })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
          continue
        }
        if (op.type === 'patchRecord') {
          try {
            const liveRecords = getState().records || []
            const rec = liveRecords.find(
              (r) =>
                (op.id && r.id === op.id) ||
                (op.match && Object.entries(op.match).every(([k, v]) => r[k] === v))
            )
            if (!rec) {
              results.push({ op, matched: false, reason: 'no-match', ids: liveRecords.map((d) => d.id) })
              continue
            }
            if (op.patch) writeRecord({ id: rec.id, patch: op.patch, source: 'devbridge' })
            results.push({ op, matched: true, id: rec.id, before: { date: rec.date, report_type: rec.report_type }, patch: op.patch })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'dumpMedEvents') {
          try {
            const all = getState().events || []
            const kw = op.drug ? String(op.drug) : null
            const med = all.filter((e) => e.drug || (e.category || '') === 'medication')
            const hit = kw ? med.filter((e) => String(e.drug || e.text || '').includes(kw)) : med
            results.push({
              op,
              matched: hit.length > 0,
              count: hit.length,
              drugs: [...new Set(med.map((e) => e.drug || e.text || '').filter(Boolean))],
              events: hit.map((e) => ({ id: e.id, date: e.date, drug: e.drug || e.text || null, dose: e.dose, unit: e.unit, stop: e.stop === true })),
            })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'setMedCourse') {
          try {
            const { key, from, to } = op
            if (!key || !from) {
              results.push({ op, matched: false, reason: 'need key+from' })
              continue
            }
            const all = getState().events || []
            const evs = all.filter((e) => normDrug(e.drug || '') === normDrug(key) || String(e.text || '').includes(key))
            if (!evs.length) {
              results.push({ op, matched: false, reason: 'no-course', drugs: [...new Set(all.map((e) => e.drug || e.text || '').filter(Boolean))] })
              continue
            }
            const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || ''))
            const doses = evs.filter((e) => e.stop !== true).sort(byDate)
            const stops = evs.filter((e) => e.stop === true).sort(byDate)
            const color = (doses[0] || stops[0] || {}).color
            let firstId
            if (doses[0]) {
              firstId = doses[0].id
              // 合并会删掉后续各段：把它们的时间与备注拼接回保留段，避免「稳定剂用量」这类历史信息丢失
              // （2026-09-19：贝林妥合并后只剩首段备注，09-05/06/08 的用量全丢）。
              // 同时首段的 time（输注时刻）必须透传，否则 buildMedEvent 重建后会把时刻抹掉。
              const droppedNotes = doses
                .slice(1)
                .map((e) => (e.note ? `${e.date}${e.time ? ' ' + e.time : ''} ${e.note}` : ''))
                .filter(Boolean)
              const mergedNote = [doses[0].note, ...droppedNotes].filter(Boolean).join('；')
              updateEvent(firstId, {
                ...buildMedEvent({
                  date: from,
                  drug: key,
                  dose: doses[0].dose != null ? doses[0].dose : null,
                  unit: doses[0].unit || '',
                  time: doses[0].time || '',
                  end: doses[0].end,
                  endTime: doses[0].endTime,
                  color,
                }),
                note: mergedNote,
              })
            } else {
              addEvent(buildMedEvent({ date: from, drug: key, dose: null, unit: '', color }))
              firstId = 'added'
            }
            const dropped = doses.slice(1).map((e) => e.id)
            doses.slice(1).forEach((e) => deleteEvent(e.id))
            if (to) {
              const sd = nextDay(to)
              const payload = buildMedEvent({ date: sd, drug: key, stop: true, color })
              if (stops[0]) updateEvent(stops[0].id, payload)
              else addEvent(payload)
              stops.slice(1).forEach((e) => deleteEvent(e.id))
              results.push({ op, matched: true, id: firstId, from, to, stopDate: sd, stopId: stops[0] ? stops[0].id : 'added', dropped })
            } else {
              stops.forEach((e) => deleteEvent(e.id))
              results.push({ op, matched: true, id: firstId, from, to: null, stopRemoved: stops.map((e) => e.id), dropped })
            }
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'dumpAllEvents') {
          try {
            const all = getState().events || []
            const kw = op.contains ? String(op.contains) : null
            const hit = kw ? all.filter((e) => JSON.stringify(e).includes(kw)) : all
            results.push({ op, matched: hit.length > 0, count: hit.length, events: hit })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'patchEvent') {
          try {
            const all = getState().events || []
            const hit = all.find(
              (e) =>
                (op.id && e.id === op.id) ||
                (op.match && Object.entries(op.match).every(([k, v]) => e[k] === v))
            )
            if (!hit) {
              results.push({ op, matched: false, reason: 'no-match', ids: all.map((e) => e.id) })
              continue
            }
            if (op.patch) updateEvent(hit.id, op.patch)
            results.push({ op, matched: true, id: hit.id, before: { date: hit.date, drug: hit.drug, note: hit.note }, patch: op.patch })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'deleteEvent') {
          try {
            const all = getState().events || []
            const hit = all.find(
              (e) =>
                (op.id && e.id === op.id) ||
                (op.match && Object.entries(op.match).every(([k, v]) => e[k] === v))
            )
            if (!hit) {
              results.push({ op, matched: false, reason: 'no-match', ids: all.map((e) => e.id) })
              continue
            }
            deleteEvent(hit.id)
            results.push({ op, matched: true, id: hit.id, removed: { date: hit.date, drug: hit.drug, stop: hit.stop === true } })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
          continue
        }
        if (op.type === 'addMedCourse') {
          try {
            const { key, from, to, dose, unit, color } = op
            if (!key || !from) {
              results.push({ op, matched: false, reason: 'need key+from' })
              continue
            }
            addEvent(buildMedEvent({ date: from, drug: key, dose: dose != null ? dose : null, unit: unit || '', color }))
            if (to) addEvent(buildMedEvent({ date: nextDay(to), drug: key, stop: true, color }))
            results.push({ op, matched: true, from, to, stopDate: to ? nextDay(to) : null })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        // 住院费用段：{ type:'addStay', start, end?, total, note? }
        // 幂等：同 start（+end）已存在则跳过，避免脚本重跑重复记账。
        if (op.type === 'addStay') {
          try {
            const { start, end = null, total, note = '' } = op
            const amt = Number(total)
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) || !Number.isFinite(amt) || amt <= 0) {
              results.push({ op, matched: false, reason: 'need valid start+total' })
              continue
            }
            const exist = (getState().stays || []).find((s) => s.start === start && (s.end || null) === end)
            if (exist) {
              results.push({ op, matched: false, reason: 'dup', id: exist.id })
              continue
            }
            addStay({ start, end: end || null, total: amt, note })
            results.push({ op, matched: true, start, end: end || null, total: amt })
          } catch (e) {
            results.push({ op, matched: false, reason: 'error', error: String(e) })
          }
        }
        if (op.type === 'ocrBench') {
          const runId = op.runId || 'bench-' + Date.now()
          results.push({ op, status: 'started', runId })
          // 立即清队列，避免定时轮询重复触发；OCR 在后台独立跑，不受 15s 全局超时限制
          await fetch('/__devbridge', { method: 'DELETE' }).catch(() => {})
          const postBench = async (payload) => {
            try {
              await fetch('/__devbridge/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'ocrBench', runId, ...payload }),
              })
            } catch {
              /* ignore */
            }
          }
          ;(async () => {
            try {
              let dataUrl = op.imageDataUrl || null
              if (!dataUrl) {
                const rec = getState().records.find((r) => r.id === op.recordId)
                if (rec) {
                  if (rec.original_image_id) {
                    const blob = await Promise.race([
                      getRecordImage(rec.original_image_id),
                      new Promise((res) => setTimeout(() => res('__to__'), 6000)),
                    ])
                    if (blob && blob !== '__to__') dataUrl = await blobToDataUrl(blob)
                  }
                  if (!dataUrl && rec.image && typeof rec.image === 'string' && rec.image.startsWith('data:')) {
                    dataUrl = rec.image
                  }
                }
              }
              if (!dataUrl) {
                await postBench({ status: 'error', error: 'no-image' })
                return
              }
              const imgH = await measureHeight(dataUrl)
              const mode = op.mode || 'sliced'
              const t0 = Date.now()
              let r
              if (mode === 'text') {
                // 检查报告通道（ocrImageToText，纯中文 psm6 整页文本）：回传全文，用于排查
                // 结论段是否被 OCR 漏识别（如流式免疫分型报告的「结论(Conclusion)」）。
                r = { text: await ocrImageToText(dataUrl) }
              } else if (mode === 'parallel') {
                r = await runLocalBestParallel(dataUrl)
              } else if (mode === 'local') {
                r = await runLocalBest(dataUrl)
              } else {
                r = await runLocalBestSliced(dataUrl, SLICE_POLICY)
              }
              const elapsedMs = Date.now() - t0
              const rows = r.grid ? r.grid.length : 0
              const mapped = r.grid ? r.grid.filter((row) => row[0] && row[0].standard_code).length : 0
              await postBench({ status: 'done', mode, imageHeight: imgH, elapsedMs, rows, mapped, // route 只在 runLocalBestSliced（生产路径）内更新，其他模式读到的是上一次的陈旧值，故标注 n/a
                  route: mode === 'sliced' ? getLastOcrRoute() : 'n/a', date: r.date || null, items: r.items ? r.items.length : 0,
                  text: typeof r.text === 'string' ? r.text : null,
                  // 流式图文报告正文（印象/结论）：浏览器产品路径是否真的把正文带出来，
                  // 只能在这里验（node 侧 ssrLoadModule 跑不了 tesseract/canvas worker）
                  narrative: r.narrative || null,
                  flowText: r.flowText || null,
                  ocrAttempts: r.ocrAttempts || null,
                  gridRows: r.grid || null })
            } catch (e) {
              await postBench({ status: 'error', error: String((e && e.message) || e) })
            }
          })()
          continue
        }
        if (op.type === 'reRecognizeDoc') {
          const runId = op.runId || 'rr-' + Date.now()
          results.push({ op, status: 'started', runId })
          // 立即清队列，避免定时轮询重复触发；重新识别要跑真实 OCR（可能数十秒），后台独立跑，避开 15s 全局超时
          await fetch('/__devbridge', { method: 'DELETE' }).catch(() => {})
          const post = async (payload) => {
            try {
              await fetch('/__devbridge/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ op: { type: 'reRecognizeDoc', runId }, runId, ...payload }]),
              })
            } catch {
              /* ignore */
            }
          }
          ;(async () => {
            try {
              const liveDocs = getState().docs || []
              const doc = liveDocs.find(
                (d) =>
                  (op.id && d.id === op.id) ||
                  (op.match && Object.entries(op.match).every(([k, v]) => d[k] === v))
              )
              if (!doc) {
                await post({ status: 'error', reason: 'no-match' })
                return
              }
              const res = await reRecognizeDoc(doc)
              if (res.skipped) {
                await post({ status: 'skipped', skipped: res.skipped, error: res.error })
                return
              }
              if (op.apply) {
                const next = { ...doc, ...res.nextFields }
                if (res.dateDiff && res.dateDiff.changed) next.date = res.dateDiff.new
                next.recognition_version = CURRENT_RECOGNITION_VERSION
                updateDoc(doc.id, next)
                await post({ status: 'done', applied: true, id: doc.id, diffCount: res.diffCount, dateOld: doc.date, dateNew: next.date, fields: Object.keys(res.nextFields), nextFields: res.nextFields })
              } else {
                await post({ status: 'preview', id: doc.id, diffCount: res.diffCount, dateOld: doc.date, dateNew: res.dateDiff ? res.dateDiff.new : doc.date, nextFields: res.nextFields, dateDiff: res.dateDiff, diffs: res.diffs })
              }
            } catch (e) {
              await post({ status: 'error', error: String((e && e.message) || e) })
            }
          })()
          continue
        }
      }
      // 回写执行结果，供命令行核验（而不是只看队列是否被清空）
      try {
        await fetch('/__devbridge/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(results),
        })
      } catch {
        /* 忽略 */
      }
      return results
    }

    const tick = async () => {
      if (!alive) return
      try {
        const r = await fetch('/__devbridge')
        const data = await r.json()
        if (data.ops && data.ops.length) {
          // 全局超时保护：任何单个 op（如读 IndexedDB）卡死都不能拖垮整个轮询循环。
          const results = await Promise.race([
            apply(data.ops),
            new Promise((res) => setTimeout(() => res(null), 15000)),
          ])
          if (results) {
            const anyMatched = results.some((x) => x.matched)
            if (anyMatched) await fetch('/__devbridge', { method: 'DELETE' })
          } else {
            // apply 超时：强制清空队列，避免旧 op 反复卡死循环
            await fetch('/__devbridge', { method: 'DELETE' }).catch(() => {})
          }
        }
      } catch {
        /* dev server 未启动 / 桥未挂载时静默忽略 */
      }
      if (alive) setTimeout(tick, 1500)
    }
    tick()
    return () => {
      alive = false
    }
  }, [])
}
