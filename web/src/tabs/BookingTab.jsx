import React from 'react'
import { Alert, Card, Typography } from 'antd'
import BookingPage from '../BookingPage.jsx'

const { Text } = Typography

export default function BookingTab() {
  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          message="114 京通真实挂号（半自动）"
          description={
            <Text style={{ fontSize: 12 }}>
              链路能自动走到「号源确认页」，但 114 的 `product/calendar` 接口对自动化会话稳定返回 461，
              缺它下发的产品键就无法自动提交，所以最后一步「选号 → 立即预约」由你在弹出的浏览器窗口里点。
              指定医生 → 命中即自动提交；未指定 → 停下等你确认。
            </Text>
          }
        />
      </Card>
      <BookingPage />
    </div>
  )
}
