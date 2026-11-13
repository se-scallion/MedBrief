// 挂号与预约（2026-11-13 合并）：原来 Sider 里是「挂号与预约」+「预约记录」两个菜单项，
// 用户抱怨「页面太多太杂」——发起挂号与查记录是同一件事的前后半段，合并成一项、页内两段。
//
// URL 兼容：?tab=booking&sub=form|orders；旧链接 ?tab=orders 会被 App 的 KEY_ALIAS 映射到这里并选中「预约记录」。
import React, { useState } from 'react'
import { Alert, Card, Tabs, Typography } from 'antd'
import BookingForm from './BookingForm.jsx'
import OrdersPage from './OrdersPage.jsx'

const { Text } = Typography

export default function BookingPage({ initialSub }) {
  const [sub, setSub] = useState(initialSub === 'orders' ? 'orders' : 'form')
  return (
    <Tabs
      activeKey={sub}
      onChange={(k) => {
        setSub(k)
        try {
          const u = new URL(window.location.href)
          u.searchParams.set('tab', 'booking')
          if (k === 'form') u.searchParams.delete('sub')
          else u.searchParams.set('sub', k)
          window.history.replaceState(null, '', u)
        } catch { /* file:// 等忽略 */ }
      }}
      items={[
        {
          key: 'form',
          label: '发起挂号',
          children: (
            <>
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
              <BookingForm />
            </>
          ),
        },
        { key: 'orders', label: '预约记录', children: <OrdersPage /> },
      ]}
    />
  )
}
