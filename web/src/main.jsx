import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'antd/dist/reset.css'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import BookingPage from './BookingPage.jsx'

dayjs.locale('zh-cn')

createRoot(document.getElementById('root')).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      token: {
        colorPrimary: '#c8102e',
        borderRadius: 8,
        fontSize: 14,
      },
    }}
  >
    <AntApp>
      <BookingPage />
    </AntApp>
  </ConfigProvider>,
)
