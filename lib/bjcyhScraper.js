// ===================== 朝阳医院主鸿鹄医生真实排班抓取器 =====================
// 目标：首都医科大学附属北京朝阳医院 血液科 主鸿鹄 (Doctor ID: 1220)
// 官网地址：https://www.bjcyh.com.cn/Html/Doctors/Main/Index_1220.html
// 说明：bjcyh 官网前置 CloudWAF，直接 curl 会返回 418，通过 Playwright headless 可以 200 正常获取真实排班

import { chromium } from 'playwright'

const TARGET_URL = 'https://www.bjcyh.com.cn/Html/Doctors/Main/Index_1220.html'

// 缓存上一次抓取结果，避免频繁启动无头浏览器
let cachedSchedule = null
let lastFetchedAt = 0
const CACHE_TTL_MS = 60 * 1000 // 缓存 1 分钟

/**
 * 抓取朝阳医院官网主鸿鹄医生的真实排班表
 * @param {boolean} force 是否强制刷新不走缓存
 */
export async function fetchLiveDoctorSchedule(force = false) {
  const now = Date.now()
  if (!force && cachedSchedule && now - lastFetchedAt < CACHE_TTL_MS) {
    return {
      ...cachedSchedule,
      fromCache: true,
      lastFetchedAt: new Date(lastFetchedAt).toISOString(),
    }
  }

  let browser = null
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    })

    const resp = await page.goto(TARGET_URL, {
      waitUntil: 'networkidle',
      timeout: 20000,
    })

    if (!resp || resp.status() !== 200) {
      throw new Error(`朝阳医院官网响应异常 HTTP ${resp ? resp.status() : 'NONE'}`)
    }

    const scraped = await page.evaluate(() => {
      const docName = '主鸿鹄'
      const title = document.querySelector('title')?.innerText || ''
      const tables = document.querySelectorAll('table')
      const parsedSlots = []

      // 遍历排班表格
      tables.forEach((table, tIndex) => {
        const rows = Array.from(table.querySelectorAll('tr'))
        if (rows.length < 2) return

        // 第0行通常为日期表头：科室 | 时段 | 星期一 11-09 | 星期二 11-10 ...
        const headerCells = Array.from(rows[0].querySelectorAll('td, th')).map(c => c.innerText.trim().replace(/\n+/g, ' '))
        // 日期列从第2列开始
        const dateHeaders = headerCells.slice(2)

        let currentDept = ''
        for (let r = 1; r < rows.length; r++) {
          const cells = Array.from(rows[r].querySelectorAll('td, th'))
          let deptCol = ''
          let periodCol = ''
          let dayCells = []

          if (cells.length >= 9) {
            // 包含科室、时段、7天
            deptCol = cells[0].innerText.trim()
            periodCol = cells[1].innerText.trim()
            dayCells = cells.slice(2)
            currentDept = deptCol
          } else if (cells.length === 8) {
            // 科室合并单元格，只有时段、7天
            deptCol = currentDept
            periodCol = cells[0].innerText.trim()
            dayCells = cells.slice(1)
          } else {
            continue
          }

          dayCells.forEach((cell, dayIdx) => {
            const rawText = cell.innerText.trim()
            const innerHtml = cell.innerHTML
            if (rawText.includes(docName)) {
              const isSuspended = innerHtml.includes('title="停诊"') || innerHtml.includes('停诊')
              const isSpecial = deptCol.includes('特需')
              const isNormal = deptCol.includes('血液科')

              // 级别推断
              let level = '专家门诊'
              let fee = 100
              if (isSpecial) {
                level = '特需门诊'
                fee = 300
              } else if (innerHtml.includes('SchedulingLevel_icon3')) {
                level = '知名专家'
                fee = 100
              }

              const dateHeader = dateHeaders[dayIdx] || `第${dayIdx + 1}天`

              parsedSlots.push({
                tableIndex: tIndex,
                department: deptCol,
                period: periodCol, // 上午 / 下午
                dateHeader, // 如 "星期二 11-10"
                doctor: docName,
                status: isSuspended ? 'suspended' : 'active',
                statusText: isSuspended ? '停诊' : '出诊中',
                level,
                fee,
              })
            }
          })
        }
      })

      return {
        title,
        slots: parsedSlots,
      }
    })

    cachedSchedule = {
      ok: true,
      source: '首都医科大学附属北京朝阳医院官网 (Index_1220.html)',
      sourceUrl: TARGET_URL,
      doctor: '主鸿鹄',
      hospital: '首都医科大学附属北京朝阳医院',
      slots: scraped.slots,
      slotCount: scraped.slots.length,
      activeCount: scraped.slots.filter(s => s.status === 'active').length,
      suspendedCount: scraped.slots.filter(s => s.status === 'suspended').length,
      ruleNotice: '朝阳医院每日 07:00 准时放第 14 天号源；官方挂号请使用「北京朝阳医院患者服务」微信小程序或「京通」平台。',
    }
    lastFetchedAt = Date.now()

    return {
      ...cachedSchedule,
      fromCache: false,
      lastFetchedAt: new Date(lastFetchedAt).toISOString(),
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      source: '首都医科大学附属北京朝阳医院官网',
      sourceUrl: TARGET_URL,
      lastFetchedAt: new Date().toISOString(),
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}
