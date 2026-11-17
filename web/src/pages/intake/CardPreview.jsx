// CardPreview —— A4 打印预览弹窗（2026-11-14 用户口径：由「页面内长 iframe」改成「按需弹窗」）
//
// 为什么是弹窗：主页面一旦平铺 3 页 A4 + 长表单，页面动辄 1700px+，交互工作台会被挤到下面。
// 打印件本身**一行没改**：仍是 buildCard().html 那份自包含纯静态 3 页（无脚本、无交互）。
//
// 打印纪律（用户 2026-11-14 明确）：
//   · 主按钮必须精准调用 `iframe.contentWindow.print()`，**绝不能打印外层弹窗遮罩**；
//   · 不支持靠 `@media print` 给 iframe 设 position:fixed 的「CSS 魔改」——
//     AntD Modal 挂在 document.body 下、不在 #root 里，Chromium 里那样只会印出截断的第 1 页；
//   · 快捷键 Cmd/Ctrl+P 由 JS 拦截后转发给 iframe；弹窗没开时按快捷键 → 不打印工作台，
//     而是自动打开本弹窗并提示「请在此打印」；
//   · 兜底始终保留「新窗口打开」（不依赖任何 CSS 技巧）。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Space, Spin, Switch, Tag, Typography } from 'antd'

const { Text } = Typography

export default function CardPreview({ open, onClose, card, embedHtml, loading, mask, onMaskChange, iframeRef, onNotify }) {
  const innerRef = useRef(null)
  // U6（AI 审核 r1）：打印预览窄屏双侧共浪费 72px（36px/侧），把 A4 双栏时间挤到孤立折行。
  // 手机：外壳贴边全屏 + body padding 0，12px 交给内容容器一层；桌面维持原样。
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 575px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 575px)')
    const on = () => setIsNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const frame = iframeRef || innerRef
  // 弹窗 iframe 只吃 embed=1 版（无浮动打印条）。服务进程仍是旧模块时会返回带条的 html，
  // 这里做一次幂等剥离兜底，保证「右下角没有浮动打印条」而不依赖重启。
  const frameHtml = (embedHtml || card?.html || '').replace(/<div class="printbar">[\s\S]*?<\/div>/g, '')

  const print = useCallback(() => {
    const win = frame.current?.contentWindow
    if (!win) { onNotify && onNotify('warning', '资料卡还没生成'); return }
    win.focus()
    win.print()
  }, [frame, onNotify])

  // 弹窗打开时把 Cmd/Ctrl+P 转给 iframe
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        print()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, print])

  const openWindow = () => {
    if (!card?.html) return onNotify && onNotify('warning', '资料卡还没生成')
    const w = window.open('', '_blank')
    if (!w) return onNotify && onNotify('warning', '浏览器拦截了新窗口，请允许弹窗后重试')
    w.document.write(card.html)
    w.document.close()
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={isNarrow ? '100vw' : '90vw'}
      style={isNarrow ? { maxWidth: '100vw', margin: 0, top: 0, paddingBottom: 0 } : { maxWidth: 960, top: 16 }}
      title={
        <Space wrap>
          <span>打印预览（3 页 A4）</span>
          <Tag color={card?.masked ? 'green' : 'orange'}>{card?.masked ? '已脱敏' : '未脱敏'}</Tag>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            报告 {card?.counts?.reports ?? 0} 份 · 指标 {card?.counts?.latest ?? 0} 项
          </Text>
        </Space>
      }
      styles={{
        container: isNarrow ? { padding: 0 } : {},
        body: isNarrow ? { background: '#eef1f4', padding: 0, borderRadius: 0, paddingBottom: 'env(safe-area-inset-bottom)' } : { background: '#eef1f4', padding: 12, borderRadius: 6 },
      }}
      footer={[
        <Space key="l" size={8} onClick={() => onMaskChange(!mask)}
          style={{ float: 'left', minHeight: 32, alignItems: 'center', cursor: 'pointer',
            background: 'rgba(15,23,42,0.88)', padding: '0 10px', borderRadius: 6 }}>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: 600, lineHeight: '32px' }}>姓名脱敏</Text>
          {/* 阻止冒泡：点 Switch 只由 onChange 切换一次，不会被外层 onClick 再翻回去 */}
          <span onClick={(e) => e.stopPropagation()}><Switch size="small" checked={mask} onChange={onMaskChange} /></span>
          <Tag color={mask ? 'green' : 'orange'} style={{ marginInlineEnd: 0 }}>{mask ? '已脱敏' : '未脱敏'}</Tag>
        </Space>,
        <Button key="win" onClick={openWindow}>新窗口打开纯净打印页</Button>,
        <Button key="close" onClick={onClose}>关闭</Button>,
        <Button key="print" type="primary" onClick={print} disabled={!card?.html}>立即打印 / 存为 PDF</Button>,
      ]}
    >
      {loading ? (
        <div style={{ height: '72vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin tip="生成中…" />
        </div>
      ) : card?.html ? (
        <div style={{ background: 'transparent', padding: isNarrow ? 12 : 0 }}>
          <iframe
            ref={frame}
            title="问诊资料卡打印预览"
            srcDoc={frameHtml}
            style={{ width: '100%', height: isNarrow ? 'calc(100dvh - 200px)' : 'calc(100vh - 240px)', minHeight: 420, border: 'none', display: 'block' }}
          />
        </div>
      ) : (
        <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
          还没有生成资料卡
        </div>
      )}
    </Modal>
  )
}
