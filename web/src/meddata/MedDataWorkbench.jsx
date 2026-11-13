// ===================== 资料导入工作台（MedBrief 原生页面的一部分） =====================
// 这里不是第二个站点：MedData 的识别组件直接渲染在 MedBrief 的「资料导入」tab 里，
// 共享同一个 React 根、同一套 antd 主题、同一个事件日志；保存落到 MedBrief 的 data/reports.json。
//
// 路由用 MemoryRouter：只为满足 MedData 组件（AiTaskCenter「继续导入」）对 useNavigate 的
// 依赖，不碰 MedBrief 的浏览器地址栏。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App as AntApp, Button, Segmented, Space, Typography } from 'antd'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import ImportFlow from '../../../meddata/src/components/ImportFlow.jsx'
import DocImportFlow from '../../../meddata/src/components/DocImportFlow.jsx'
import AiTaskCenter from '../../../meddata/src/components/AiTaskCenter.jsx'
import { hydrate } from './store.js'
import { useLog } from '../App.jsx'
import './embedded.css'

const { Text } = Typography

function FlowFromLocation({ onImported }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { message } = AntApp.useApp()
  const { pushLog } = useLog()
  const [nonce, setNonce] = useState(0)
  const params = useMemo(() => new URLSearchParams(location.search), [location.search])
  const taskId = params.get('task') || ''
  const flow = params.get('flow') === 'doc' ? 'doc' : 'lab'
  const key = `${flow}:${taskId}:${nonce}`

  useEffect(() => { hydrate(true) }, [key])

  // 保存结果由 store 适配层异步回报：成功刷新 MedBrief 已导入列表，失败留在页面上提示，绝不假装成功。
  useEffect(() => {
    const onSaved = (e) => {
      const id = e.detail?.id || ''
      message.success(`已入库 ${id}（MedBrief 报告库）`)
      pushLog(`MedData 识别结果已入库 ${id}，共 ${e.detail?.total ?? '?'} 份报告`, 'ok')
      onImported?.()
    }
    const onFailed = (e) => {
      const err = e.detail?.error || '入库失败'
      message.error(err)
      pushLog(`MedData 识别结果入库失败：${err}`, 'err')
    }
    window.addEventListener('medbrief:report-saved', onSaved)
    window.addEventListener('medbrief:report-failed', onFailed)
    return () => {
      window.removeEventListener('medbrief:report-saved', onSaved)
      window.removeEventListener('medbrief:report-failed', onFailed)
    }
  }, [message, pushLog, onImported])

  const reset = useCallback(() => {
    setNonce((n) => n + 1)
    navigate('/reports/add?flow=' + flow, { replace: true })
  }, [navigate, flow])

  const switchFlow = useCallback((next) => {
    navigate(`/reports/add?flow=${next}`, { replace: true })
  }, [navigate])

  const common = {
    onClose: reset,
    onSaved: reset,
    onSwitchFlow: switchFlow,
    onOpenDoc: () => { message.info('归档记录见下方「资料卡与档案」里的已导入报告') },
    pendingToken: '',
    pendingIndex: 0,
    batchTotal: 0,
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} className="medbrief-meddata-workbench">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Space size={10} wrap>
          <Segmented
            value={flow}
            onChange={switchFlow}
            options={[
              { label: '化验单识别', value: 'lab' },
              { label: '检查报告 · AI 精读', value: 'doc' },
            ]}
          />
          <Button size="small" onClick={reset}>重新上传</Button>
          {taskId && <Text type="secondary" style={{ fontSize: 12 }}>已从 AI 任务恢复草稿 · {taskId.slice(-8)}</Text>}
        </Space>
        <AiTaskCenter />
      </div>
      <Alert
        type="info"
        showIcon
        message="识别结果直接进 MedBrief 报告库（data/reports.json），可在「资料卡与档案」里查看、生成问诊资料卡；原件按 sha256 只存一份。"
        style={{ fontSize: 12 }}
      />
      <div key={key} style={{ minHeight: 420 }}>
        {flow === 'doc'
          ? <DocImportFlow {...common} taskId={taskId} />
          : <ImportFlow {...common} taskId={taskId} />}
      </div>
    </Space>
  )
}

export default function MedDataWorkbench({ onImported }) {
  return (
    <MemoryRouter initialEntries={['/reports/add?flow=lab']}>
      <FlowFromLocation onImported={onImported} />
    </MemoryRouter>
  )
}
