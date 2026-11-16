// UploadPanel：从 IntakePage.jsx 原样切出的第 ① 块（2026-11-13 抽页）
// 2026-11-17 批量导入交互重构（计划 v0.14 / 规格 v1.8，用户「按以上计划执行」）：
//   · 卡片头 = Checkbox + 序号徽标 + 状态 Tag + 文件名 + 移除图标（非 danger）
//   · 撤掉每卡整行「识别」；只在 done/failed 出「重新识别 / 重试」
//   · 顶部两处冗余入口（识别全部按钮、勾选/拼接/清空那一行）整行删除，改由下方 sticky 操作栏承载
//   · 操作栏：sticky 占位（不遮内容）+ 三态渐进按钮 + 「更多」Dropdown
//   · 组件一律 antd（规格 §1.1），只允许覆盖尺寸/热区/布局作用域，不改外观
import React from 'react'
import {
  Badge, Button, Card, Checkbox, Col, Dropdown, Empty, Flex, Grid, Image, Popover, Row,
  Space, Spin, Tag, Tooltip, Typography, Upload,
} from 'antd'
const { Dragger } = Upload
import { ST, fmtSize } from './shared.js'

const { Text } = Typography

// 图标一律内联 SVG：本项目**没有**装 @ant-design/icons（规格 §1.1 写的"已装"不成立），
// 且既有惯例就是零新增依赖（ReportDayList.jsx:26、TrendsTab.jsx、SourceModal.jsx）。
const Svg = ({ d, size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={d} />
  </svg>
)
const SVG_TRASH = 'M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14 M10 11v5 M14 11v5'
const SVG_RELOAD = 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7'
const SVG_MORE = 'M5 12h.01 M12 12h.01 M19 12h.01'

// 尺寸/热区/布局作用域 —— 规格 §1.1 红线 1 允许的两类覆盖，不重画外观
const MB_BATCH_CSS = `
.mb-upload-body { display: flex; flex-direction: column; margin: 0 -12px -12px; }

.mb-item-card .ant-card-head-title { padding: 6px 0; }
.mb-item-card .ant-card-head { min-height: 32px; padding: 0 8px; overflow: visible; }
/* 规格 v1.9 §2.4：图标热区靠 ::before{inset:-10px} 外扩 ⇒ 祖先链必须 overflow:visible，
   否则 44 热区被裁（实现方实测 375/414 四点里三点落空）。head 与 extra 两层都写，
   并由 A6 的父链断言兜底（不靠这句注释）。 */
.mb-item-card .ant-card-extra { padding: 6px 0; overflow: visible; }
.mb-item-card .ant-card-body { padding: 8px; }
.mb-head-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.mb-file-name { flex: 1 1 auto; min-width: 96px; font-size: 13px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mb-hit44 { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.mb-hit44::before { content: ''; position: absolute; inset: -14px; }
.mb-pick-badge { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; flex: 0 0 auto; }
.mb-pick-badge .ant-badge-count,
.mb-pick-badge .ant-scroll-number-custom-component {
  width: 16px; min-width: 16px; height: 16px; line-height: 16px; padding: 0; font-size: 11px;
  background: #c8102e; color: #fff; border-radius: 50%; text-align: center; box-shadow: none;
}
.mb-pick-badge .ant-badge-count .ant-scroll-number-only { height: 16px; line-height: 16px; }
.mb-icon-btn.ant-btn { width: 24px; min-width: 24px; height: 24px; padding: 0; position: relative; flex: 0 0 auto; }
.mb-icon-btn.ant-btn::before { content: ''; position: absolute; inset: -10px; }
.mb-bar-btn.ant-btn { white-space: nowrap; }
.mb-bar-hint { font-size: 12px; line-height: 16px; white-space: nowrap; color: #8c8c8c; }
.mb-batchbar {
  position: sticky; bottom: 0; z-index: 6;
  margin: 8px 0 0; padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
  background: #fff; border-top: 1px solid #f0f0f0;
  box-shadow: 0 -2px 8px rgba(0,0,0,.06); border-radius: 0 0 8px 8px;
  display: flex; flex-direction: column; gap: 0;
}
.mb-batchbar-row { display: flex; align-items: center; gap: 8px; }
@media (max-width: 575px) {
  .mb-batchbar .mb-bar-btn { height: 44px; flex: 1 1 0; min-width: 0; }
  .mb-batchbar .mb-bar-btn-icon { height: 44px; width: 44px; flex: 0 0 auto; }
}
@media (max-width: 767px) {
  /* !important 是必要的：antd Button 自带 flex 简写，普通特异性压不住（实测 computed 仍是 0 0 auto） */
  .mb-batchbar .mb-bar-btn { flex: 1 1 0 !important; min-width: 0 !important; }
}
`

export default function UploadPanel({
  items, pendingCount, failedCount, dupCount,
  predupCount = 0, libDupCount = 0, hashSkippedCount = 0, importableCount = 0,
  selected, stitching, addFiles, recognize, doStitch, removeItem, toggleSelect,
  removeSelected, batch, onBatchStop, onRecognizeAll, onImportAll,
  maxSelect = 4, maxStitch = 2,
}) {
  const screens = Grid.useBreakpoint()
  const xs = !screens.sm
  const pickedIds = selected
  const selCount = selected.length
  const settleHint = selCount > maxStitch && selCount <= maxSelect

  // 顶部计数：优先级固定（规格 §7.4）—— 越靠左越"需要立刻知道"
  // 规格 §7.4：查重四项按优先级排前（本批未做文件查重 > 疑似重复（粗判）> 已导入过 > 疑似同一份报告），
  // 共N/待识别/未识别 属常规计数，排后 —— 375 折叠成 +N 时先折的必须是常规计数，不能是关键查重信息。
  const tags = []
  if (hashSkippedCount > 0) tags.push(<Tag key="hashoff" color="default">本批未做文件查重</Tag>)
  if (predupCount > 0) tags.push(<Tag key="predup" color="orange" data-testid="mb-predup-count">疑似重复（粗判）{predupCount}</Tag>)
  if (libDupCount > 0) tags.push(<Tag key="libdup" color="orange">已导入过 {libDupCount}</Tag>)
  if (dupCount > 0) tags.push(<Tag key="dup" color="orange">疑似同一份报告 {dupCount}</Tag>)
  tags.push(<Tag key="total">共 {items.length} 张</Tag>)
  if (pendingCount > 0) tags.push(<Tag key="pending" color="default">待识别 {pendingCount}</Tag>)
  if (failedCount > 0) tags.push(<Tag key="failed" color="red">未识别 {failedCount}</Tag>)
  const shownTags = xs && tags.length > 2 ? tags.slice(0, 2) : tags
  const foldedTags = xs && tags.length > 2 ? tags.slice(2) : []

  const clearMenu = {
    items: [{ key: 'clear', label: '清空勾选', disabled: !selCount }],
    onClick: ({ key }) => { if (key === 'clear') removeSelected && removeSelected([]) },
  }

  return (
    <Card
      size="small"
      title="① 批量导入"
      extra={
        <Space wrap size={4}>
          {shownTags}
          {foldedTags.length > 0 && (
            <Popover content={<Space wrap size={4}>{foldedTags}</Space>} title="更多计数">
              <Tag style={{ cursor: 'pointer' }}>+{foldedTags.length}</Tag>
            </Popover>
          )}
          {batch?.mode === 'ocr' ? (
            <>
              <Tag color="processing">识别中 {batch.done}/{batch.total}</Tag>
              <Button size="small" danger onClick={onBatchStop}>停止</Button>
            </>
          ) : null}
        </Space>
      }
    >
      <style>{MB_BATCH_CSS}</style>
      <div className="mb-upload-body">
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
              也可以直接 Ctrl/⌘+V 粘贴截图。手机把一张单拍成两张时，勾选这两张后在下方点「拼接」。
            </p>
          </Dragger>

          {items.length > 0 && (
            <Row gutter={[10, 10]}>
              {items.map((item) => {
                const st = ST[item.status] || ST.pending
                const picked = pickedIds.includes(item.id)
                const order = pickedIds.indexOf(item.id)
                const predup = item.predup
                return (
                  <Col xs={24} sm={12} md={8} key={item.id}>
                    <Card
                      size="small"
                      className="mb-item-card"
                      style={picked ? { borderColor: '#c8102e', boxShadow: '0 0 0 1px #c8102e inset' } : undefined}
                      title={
                        <span className="mb-head-row">
                          <Checkbox
                            checked={picked}
                            aria-label="选择此文件（用于拼接/批量操作）"
                            onChange={() => toggleSelect(item.id)}
                            className="mb-hit44"
                          />
                          {picked && (
                            <Badge
                              className="mb-pick-badge"
                              count={<span className="mb-badge-txt">{'①②③④'[order] || order + 1}</span>}
                              showZero={false}
                            />
                          )}
                          <Tag color={st.color} style={{ marginInlineEnd: 0 }}>{st.label}</Tag>
                          <span className="mb-file-name" title={item.name}>{item.name}</span>
                        </span>
                      }
                      extra={
                        <Button
                          // 不加 danger：antd 的 .ant-btn-dangerous 常态就是 #ff4d4f，
                          // 而「移除未入库条目」可反悔（重新拖进来即可），不必常态红脸。
                          type="text"
                          shape="circle"
                          size="small"
                          icon={<Svg d={SVG_TRASH} />}
                          className="mb-icon-btn"
                          aria-label="移除此文件"
                          title="移除此文件"
                          onClick={() => removeItem(item.id)}
                        />
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
                        <Flex align="center" justify="space-between" gap={8} wrap="wrap">
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
                            {predup && (
                              <Tag className="mb-predup" color="orange" title={predup.kind === 'exact-file'
                                ? '本文件的 sha256 与库内已有文件完全相同；入库时仍会再判一次'
                                : '按「文件名 + 大小」粗判（本批未做精确查重），请核对后决定是否保留'}>
                                {predup.kind === 'exact-file' ? '同一文件已导入过' : '可能重复（按文件名+大小粗判，请核对）'}
                              </Tag>
                            )}
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {item.rows.length ? `${item.rows.length} 行` : '0 行'}
                            </Text>
                          </Space>
                          {(item.status === 'done' || item.status === 'failed') && (
                            <Button
                              size="small"
                              icon={<Svg d={SVG_RELOAD} />}
                              danger={item.status === 'failed'}
                              loading={item.status === 'ocr'}
                              onClick={() => recognize(item)}
                              style={{ flex: '0 0 auto' }}
                            >
                              {item.status === 'failed' ? '重试' : '重新识别'}
                            </Button>
                          )}
                          {item.status === 'ocr' && (
                            <Space size={6}>
                              <Spin size="small" />
                              <Text type="secondary" style={{ fontSize: 12 }}>识别中…</Text>
                            </Space>
                          )}
                        </Flex>
                      </Space>
                    </Card>
                  </Col>
                )
              })}
            </Row>
          )}

          {items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有图片" />}
        </Space>

        {/* 渲染条件只有 items.length > 0（规格 v1.3：不加 sec 条件、不在 scroll 回调里 setState） */}
        {items.length > 0 && (
          <Flex className="mb-batchbar" vertical>
            {batch?.mode === 'ocr' ? (
              <div className="mb-batchbar-row">
                <Text type="secondary" style={{ fontSize: 12, flex: '1 1 auto' }}>识别中 {batch.done}/{batch.total}</Text>
                <Button className="mb-bar-btn mb-bar-btn-icon" danger data-bar-btn data-act="stop" onClick={onBatchStop}>停止</Button>
              </div>
            ) : (
              <>
                {settleHint && (
                  <Text className="mb-bar-hint">先拼前两张，再继续加</Text>
                )}
                <div className="mb-batchbar-row">
                  {selCount === 0 && (
                    <>
                      <Button
                        className="mb-bar-btn" type="primary" data-bar-btn data-act="recognize"
                        title={`识别全部 ${pendingCount + failedCount} 张（串行，可停止）`}
                        onClick={onRecognizeAll}
                      >
                        识别（{pendingCount + failedCount}）
                      </Button>
                      <Button
                        className="mb-bar-btn" data-bar-btn data-act="import"
                        title={`只入库已识别且未入库的 ${importableCount} 张；疑似重复会自动跳过`}
                        onClick={onImportAll}
                      >
                        导入（{importableCount}）
                      </Button>
                    </>
                  )}
                  {selCount === 1 && (
                    <>
                      <Button className="mb-bar-btn" data-bar-btn data-act="remove" onClick={() => removeSelected(selected)}>
                        移除选中
                      </Button>
                      <Dropdown menu={clearMenu} trigger={['click']}>
                        <Button
                          className="mb-bar-btn mb-bar-btn-icon" type="text" icon={<Svg d={SVG_MORE} />}
                          aria-label="更多" data-bar-btn data-act="more"
                        />
                      </Dropdown>
                    </>
                  )}
                  {selCount >= 2 && (
                    <>
                      <Button
                        className="mb-bar-btn" type="primary" data-bar-btn data-act="stitch"
                        disabled={selCount > maxStitch}
                        aria-disabled={selCount > maxStitch ? 'true' : undefined}
                        title={selCount > maxStitch ? `本次最多拼 ${maxStitch} 张（多张拼接待实测放行）` : '按勾选顺序纵向拼接'}
                        loading={stitching}
                        onClick={doStitch}
                      >
                        拼接（{selCount}）
                      </Button>
                      <Button className="mb-bar-btn" data-bar-btn data-act="remove" onClick={() => removeSelected(selected)}>
                        移除选中
                      </Button>
                      <Dropdown menu={clearMenu} trigger={['click']}>
                        <Button
                          className="mb-bar-btn mb-bar-btn-icon" type="text" icon={<Svg d={SVG_MORE} />}
                          aria-label="更多" data-bar-btn data-act="more"
                        />
                      </Dropdown>
                    </>
                  )}
                </div>
              </>
            )}
          </Flex>
        )}
      </div>
    </Card>
  )
}
