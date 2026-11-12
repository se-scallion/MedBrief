import { useEffect, useState } from 'react'

let audioCtx = null

// 放号预警蜂鸣（Web Audio，三连升调）
export function playChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    const now = audioCtx.currentTime
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.setValueAtTime(1320, now + 0.12)
    osc.frequency.setValueAtTime(1760, now + 0.24)
    gain.gain.setValueAtTime(0.3, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
    osc.start(now)
    osc.stop(now + 0.5)
  } catch (e) {
    console.warn('Audio chime error:', e)
  }
}

const pad = (n) => String(n).padStart(2, '0')

// 北京时间和「下一个 07:00」的剩余秒数（与旧工作台口径一致，用 UTC+8 硬算，不依赖本机时区）
export function computeCountdown(now = new Date()) {
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const bj = new Date(utc + 3600000 * 8)
  const target = new Date(bj)
  target.setHours(7, 0, 0, 0)
  if (bj.getTime() >= target.getTime()) target.setDate(target.getDate() + 1)
  const totalSec = Math.max(0, Math.floor((target.getTime() - bj.getTime()) / 1000))
  const release = new Date(bj)
  release.setDate(release.getDate() + 14)
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return {
    totalSec,
    clock: `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(totalSec % 60)}`,
    targetText: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} 07:00:00`,
    releaseDate: fmt(release),
  }
}

// 每秒刷新的倒计时 Hook；到 300s / 60s / 10s 时回调 onMilestone
export function useCountdown({ enabled = true, onMilestone } = {}) {
  const [state, setState] = useState(() => computeCountdown())
  useEffect(() => {
    const tick = () => {
      const next = computeCountdown()
      setState(next)
      if (enabled && onMilestone) onMilestone(next.totalSec)
    }
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [enabled, onMilestone])
  return state
}
