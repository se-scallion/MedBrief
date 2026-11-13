// ===================== 同步状态小圆点（顶栏常驻） =====================
// 显示与 SQLite 数据源（data-server, 8787）的连接/同步状态：
//   灰 = 未连接（仅本机） / 黄(呼吸) = 同步中 / 绿 = 已同步 / 红 = 连接异常
//
// 悬停显示固定位置浮层（锚定圆点正下方，不跟随鼠标；纯信息、无任何可点控件，
// pointer-events-none 防止浮层挡住鼠标造成闪烁）——符合「浮层内禁止放可点控件」铁律。
// 完整操作（开关/重传）仍在设置页「数据源」面板。
//
// 「同步中」保底展示 1.5s：本机推送一个来回 <1s，黄点若按真实时长闪现
// 肉眼根本看不到（2026-09-27 实测教训）。这里只做展示层驻留，不改 apiStore 状态机。

import { useEffect, useRef, useState } from 'react'
import { getStatus, subscribe } from '../utils/apiStore.js'

const DOT = {
  off: 'bg-slate-500',
  syncing: 'bg-amber-400 animate-pulse',
  ok: 'bg-emerald-400',
  error: 'bg-red-500',
}

const STATE_TEXT = {
  off: '未连接数据源（数据仅存本机）',
  syncing: '正在与 SQLite 同步…',
  ok: '已同步',
  error: '连接异常',
}

const SYNCING_MIN_MS = 1500

function relative(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  if (ms < 10e3) return '刚刚'
  if (ms < 60e3) return `${Math.floor(ms / 1e3)} 秒前`
  if (ms < 3600e3) return `${Math.floor(ms / 60e3)} 分钟前`
  if (ms < 86400e3) return `${Math.floor(ms / 3600e3)} 小时前`
  return `${Math.floor(ms / 86400e3)} 天前`
}

export default function SyncDot() {
  const [status, setStatus] = useState(getStatus())
  const [hover, setHover] = useState(false)
  useEffect(() => subscribe(() => setStatus(getStatus())), [])

  // 展示层状态机：真实 state 变化直接跟随，唯一例外是离开 syncing 时驻留满保底时长
  const realKey = !status.enabled ? 'off' : status.state
  const [shown, setShown] = useState(realKey)
  const syncingSince = useRef(0)

  useEffect(() => {
    if (realKey === shown) return
    if (realKey === 'syncing') {
      syncingSince.current = Date.now()
      setShown('syncing')
      return
    }
    const hold = Math.max(0, SYNCING_MIN_MS - (Date.now() - syncingSince.current))
    const t = setTimeout(() => setShown(realKey), hold)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realKey])

  return (
    <span
      className="relative inline-flex items-center shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${DOT[shown] || DOT.off}`}
        data-sync-state={shown}
      />
      {hover && (
        <span
          className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-none
                     whitespace-nowrap rounded-md bg-slate-800/95 text-slate-200 text-[11px] leading-5
                     px-3 py-2 shadow-xl border border-white/10"
        >
          <span className="font-medium">{STATE_TEXT[shown] || shown}</span>
          {shown !== 'off' && status.version > 0 && (
            <span className="text-slate-400"> · 版本 {status.version}</span>
          )}
          {status.lastSyncAt && (
            <span className="block text-slate-400">
              上次同步 {status.lastSyncAt.replace('T', ' ').slice(0, 19)}（{relative(status.lastSyncAt)}）
            </span>
          )}
          {shown === 'error' && status.error && (
            <span className="block text-red-300 max-w-72 truncate" title={status.error}>
              {status.error}
            </span>
          )}
          <span className="block text-slate-500">数据统一存项目机 SQLite · 详细操作在 设置 → 数据源</span>
        </span>
      )}
    </span>
  )
}
