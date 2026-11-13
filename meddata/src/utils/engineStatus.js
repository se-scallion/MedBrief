// ===================== 识别引擎可用性（离线服务是否启动）=====================
// 四类引擎的「服务」不一样，探测方式因此分两条：
//   · 本地离线（local）：浏览器里的 tesseract worker —— 看 src/utils/ocr.js 的 localEngineState
//   · 本机/云端（vision / mineru / ai）：都由 8008 网关（server.mjs）托管 —— 看 GET /api/engine-status
// UI 只消费统一的 { state, note }：
//   ready    可用（选项不加任何后缀）
//   starting 正在启动（下拉选项直接显示「启动中…」）
//   probing  尚未探到结果（首帧，同样按「检测中…」提示，避免误报离线）
//   offline  离线/未启动（显示「服务未启动」，note 里带具体原因）
//
// 为什么必须在选项上提示：识别失败后用户要换个引擎重跑，如果新选的引擎本身就没起来，
// 点下去只会再失败一次，用户会以为「换引擎也没用」。所以状态要前置到选项文案里。
import { useCallback, useEffect, useRef, useState } from 'react'
import { ENGINES } from './ocrEngines.js'
import { getLocalEngineState, subscribeLocalEngineState } from './ocr.js'

const STATUS_URL = '/api/engine-status'
const PROBE_TIMEOUT_MS = 2500
// 网关可能正在启动（launchd 刚拉起 / 刚点开 dev server）：连续失败才判离线，中途显示「启动中…」
const PROBE_RETRY_DELAYS = [0, 800, 1800]
const POLL_READY_MS = 30_000
const POLL_DOWN_MS = 5_000 // 有服务离线时高频探测：用户把服务起起来后，提示会自动消失
const GATEWAY_DOWN_NOTE = '识别网关未启动（127.0.0.1:8008）'

// 选项文案后缀（ready 不加后缀）
export const STATE_TEXT = { ready: '', starting: '启动中…', probing: '检测中…', offline: '服务未启动' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 本地离线引擎：worker 就绪 / 加载中 / 初始化失败
function localEntry() {
  const s = getLocalEngineState()
  if (s === 'ready') return { state: 'ready', note: '' }
  if (s === 'failed') return { state: 'offline', note: '本机 OCR 引擎初始化失败，点识别会自动重建' }
  return { state: 'starting', note: '本机 OCR 引擎加载中（首次约 10–20 秒）' }
}

// 网关侧引擎：{ ready, reason } → { state, note }
function remoteEntry(part, fallbackNote) {
  if (part && part.ready) return { state: 'ready', note: '' }
  return { state: 'offline', note: (part && part.reason) || fallbackNote }
}

function initialHealth() {
  return {
    local: localEntry(),
    vision: { state: 'probing', note: '' },
    mineru: { state: 'probing', note: '' },
    ai: { state: 'probing', note: '' },
  }
}

// 引擎可用性 hook：{ health, healthRef, refresh }
// healthRef 供「回调里读最新状态」用（识别失败后的默认换引擎不能用过期的 state 快照）
export function useEngineHealth() {
  const [health, setHealth] = useState(initialHealth)
  const healthRef = useRef(health)
  const aliveRef = useRef(true)
  const timerRef = useRef(null)
  const busyRef = useRef(false)

  const update = useCallback((patch) => {
    const next = { ...healthRef.current, ...patch }
    healthRef.current = next
    if (aliveRef.current) setHealth(next)
  }, [])

  const probeRemote = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      for (let i = 0; i < PROBE_RETRY_DELAYS.length; i++) {
        if (i > 0) {
          await sleep(PROBE_RETRY_DELAYS[i])
          if (!aliveRef.current) return
          // 只有「还不知道状态」时才显示启动中：已经判定离线的引擎不要每轮重试都闪一下「启动中…」
          const cur = healthRef.current
          if (cur.vision.state === 'probing' || cur.vision.state === 'starting') {
            const starting = { state: 'starting', note: '识别网关启动中…' }
            update({ vision: starting, mineru: starting, ai: starting })
          }
        }
        try {
          const res = await fetch(STATUS_URL, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            cache: 'no-store',
          })
          if (!res.ok) throw new Error('status ' + res.status)
          const j = await res.json()
          const e = (j && j.engines) || {}
          update({
            vision: remoteEntry(e.vision, GATEWAY_DOWN_NOTE),
            mineru: remoteEntry(e.mineru, GATEWAY_DOWN_NOTE),
            ai: remoteEntry(e.ai, GATEWAY_DOWN_NOTE),
          })
          return
        } catch {
          /* 网关可能正在启动，继续重试 */
        }
      }
      // 全部重试都失败：网关根本没起来 → 三个网关引擎一律按离线提示
      const down = { state: 'offline', note: GATEWAY_DOWN_NOTE }
      update({ vision: down, mineru: down, ai: down })
    } finally {
      busyRef.current = false
    }
  }, [update])

  // 本地引擎：订阅 ocr.js 的就绪状态（worker 创建中 / 可用 / 失败）
  useEffect(() => {
    aliveRef.current = true
    update({ local: localEntry() })
    const off = subscribeLocalEngineState(() => update({ local: localEntry() }))
    return () => {
      aliveRef.current = false
      off()
    }
  }, [update])

  // 网关引擎：首帧探测 + 轮询（离线时 5s，就绪时 30s；页面不可见时跳过，回来立刻探）
  useEffect(() => {
    let stopped = false
    const tick = () => {
      const anyDown = Object.values(healthRef.current).some((v) => v.state !== 'ready')
      timerRef.current = setTimeout(async () => {
        if (stopped) return
        if (document.visibilityState === 'visible') await probeRemote()
        tick()
      }, anyDown ? POLL_DOWN_MS : POLL_READY_MS)
    }
    probeRemote()
    tick()
    const onVisible = () => {
      if (document.visibilityState === 'visible') probeRemote()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timerRef.current) clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [probeRemote])

  const refresh = useCallback(() => probeRemote(), [probeRemote])
  return { health, healthRef, refresh }
}

// 选项文案：就绪不加后缀，启动中/离线直接把提示写进文案
export function engineOptionLabel(name, health) {
  const base = (ENGINES[name] && ENGINES[name].label) || name
  const st = health && health[name] ? health[name].state : ''
  const suffix = st ? STATE_TEXT[st] || '' : ''
  return suffix ? `${base}（${suffix}）` : base
}

// 选中引擎的问题说明（下拉下方一行小字）
export function engineNote(name, health) {
  const e = health && health[name]
  if (!e || e.state === 'ready') return ''
  return e.note || ''
}

// 失败后默认换引擎：绝不把刚失败的那个留在选中态
// 优先级：已就绪的本机离线引擎 > 已就绪的云端引擎 > 状态未知/启动中 > 已知离线
// （云端引擎仍受隐私确认门禁保护，选中不等于会上传）
export function pickEngineAfterFailure(failed, health) {
  const names = Object.keys(ENGINES).filter((n) => n !== failed)
  if (!names.length) return failed
  const rank = (n) => {
    const st = health && health[n] ? health[n].state : ''
    if (st === 'offline') return 3
    if (ENGINES[n] && ENGINES[n].isCloud) return 2
    return 1
  }
  // sort 稳定：同优先级保持 ENGINES 声明顺序（local → vision → mineru → ai）
  return names.slice().sort((a, b) => rank(a) - rank(b))[0]
}
