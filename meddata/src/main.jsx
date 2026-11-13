import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { MotionConfig } from 'motion/react'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import App from './App.jsx'
import { HashRouter } from 'react-router-dom'
import 'antd/dist/reset.css'
import './index.css'

dayjs.locale('zh-cn')

// 主色对齐品牌色（tailwind brand-600 #0d9488），让 antd 控件与既有界面风格统一
const brandColor = '#0d9488'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: brandColor,
            borderRadius: 8,
            fontSize: 14,
          },
          algorithm: theme.defaultAlgorithm,
        }}
      >
        <AntApp>
          {/* reducedMotion="user"：系统开启「减少动效」时全站关闭动画（含路由转场 / FLIP） */}
          <MotionConfig reducedMotion="user">
            <App />
          </MotionConfig>
        </AntApp>
      </ConfigProvider>
    </HashRouter>
  </React.StrictMode>
)
