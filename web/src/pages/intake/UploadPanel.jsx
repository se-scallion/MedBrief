// UploadPanel：从 IntakePage.jsx 原样切出的第 ① 块（2026-11-13 抽页，JSX 逐字未改）
import React from 'react'
import {
  Alert, App as AntApp, Button, Card, Col, Collapse, Divider, Empty, Form, Image,
  Input, Modal, Row, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, Upload,
} from 'antd'
const { Dragger } = Upload
import { ST, KIND_OPTIONS, FLAG_TEXT, uid, fmtSize, rawJson, postJson } from './shared.js'

const { Text, Paragraph } = Typography
export default function UploadPanel({ items, pendingCount, failedCount, dupCount, selected, setSelected, stitching, addFiles, recognize, doStitch, removeItem, toggleSelect, batch, onBatchStop, onRecognizeAll }) {
  return (
    <Card
      size="small"
      title="① 批量导入"
      extra={
        <Space wrap>
          <Tag>共 {items.length} 张</Tag>
          {pendingCount > 0 && <Tag color="default">待识别 {pendingCount}</Tag>}
          {failedCount > 0 && <Tag color="red">未识别 {failedCount}</Tag>}
          {dupCount > 0 && <Tag color="orange">疑似重复 {dupCount}</Tag>}
          {batch?.mode === 'ocr' ? (
            <>
              <Tag color="processing">识别中 {batch.done}/{batch.total}</Tag>
              <Button size="small" danger onClick={onBatchStop}>停止</Button>
            </>
          ) : (
            <Button size="small" type="primary" onClick={onRecognizeAll}
              title={pendingCount + failedCount === 0 ? '当前没有待识别的图片（已识别的不重复跑）' : '逐张识别，串行执行，可随时停止'}>
              一键识别全部{pendingCount + failedCount > 0 ? `（${pendingCount + failedCount}）` : ''}
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Dragger
          multiple
          accept="image/*,application/pdf"
          showUploadList={false}
          // 注意：antd 对每个文件都会调用一次 beforeUpload，且第二个参数是「整个批次」。
          // 若在这里 addFiles(fileList)，选 2 张就会被加进 2×2=4 条（重复导入）。
          beforeUpload={(file) => {
            addFiles([file])
            return false
          }}
        >
          <p style={{ margin: '8px 0', fontSize: 13 }}>点这里选择图片，或把报告截图拖进来（支持多选）</p>
          <p style={{ margin: 0, fontSize: 12, color: '#8c8c8c' }}>
            也可以直接 Ctrl/⌘+V 粘贴截图。手机把一张单拍成两张时，勾选这两张后点「拼接」。
          </p>
        </Dragger>

        {items.length > 0 && (
          <>
            <Space wrap>
              <Text style={{ fontSize: 12 }}>已勾选 {selected.length}/2（用于拼接）</Text>
              <Button size="small" onClick={doStitch} loading={stitching} disabled={selected.length !== 2}>
                拼接选中的两张
              </Button>
              <Button size="small" onClick={() => setSelected([])} disabled={!selected.length}>
                清空勾选
              </Button>
            </Space>

            <Row gutter={[10, 10]}>
              {items.map((item) => {
                const st = ST[item.status] || ST.pending
                const picked = selected.includes(item.id)
                return (
                  <Col xs={24} sm={12} md={8} key={item.id}>
                    <Card
                      size="small"
                      style={{ borderColor: picked ? '#1677ff' : undefined }}
                      title={
                        <Space size={6} wrap>
                          <Tag color={st.color}>{st.label}</Tag>
                          <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: item.name }}>
                            {item.name}
                          </Text>
                        </Space>
                      }
                      extra={
                        <Space size={4}>
                          <Button
                            size="small"
                            type={picked ? 'primary' : 'default'}
                            onClick={() => toggleSelect(item.id)}
                          >
                            {picked ? '已选' : '选'}
                          </Button>
                          <Button size="small" type="text" danger onClick={() => removeItem(item.id)}>
                            删
                          </Button>
                        </Space>
                      }
                    >
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        {item.dataUrl && item.isPdf ? (
                          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', borderRadius: 8, color: '#8c8c8c', fontSize: 13 }}>
                            PDF 文件
                          </div>
                        ) : item.dataUrl ? (
                          <Image src={item.dataUrl} height={120} style={{ objectFit: 'contain' }} />
                        ) : (
                          <Space>
                            <Spin size="small" />
                            <Text type="secondary" style={{ fontSize: 12 }}>读取中…</Text>
                          </Space>
                        )}
                        <Space size={6} wrap>
                          <Text type="secondary" style={{ fontSize: 12 }}>{fmtSize(item.size)}</Text>
                          {item.source === 'stitch' && <Tag color="blue">拼接图</Tag>}
                          {item.chunked && (
                            <Tooltip
                              title={`拼图过高（h/w ${item.chunkAspect}），Vision 会内部降采样、中间带成片丢行，已切成 ${item.chunks} 块分别识别后合并`}
                            >
                              <Tag color="purple">已切 {item.chunks} 块识别</Tag>
                            </Tooltip>
                          )}
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.rows.length ? `${item.rows.length} 行` : '0 行'}
                          </Text>
                        </Space>
                        <Button size="small" onClick={() => recognize(item)} loading={item.status === 'ocr'} block>
                          {item.status === 'done' ? '重新识别' : '识别'}
                        </Button>
                      </Space>
                    </Card>
                  </Col>
                )
              })}
            </Row>
          </>
        )}

        {items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有图片" />}
      </Space>
    </Card>
  )
}
