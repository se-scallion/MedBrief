// ===================== 图形验证码识别（OCR → AI 视觉 → 手动兜底） =====================
// 实测背景（2026-11-12）：
//   114 图形验证码为 4 位数字，每个数字一种纯色、加干扰线与噪点。
//   逐色分离 + tesseract 单字识别在本会话对 4/4 张样本命中（1121 / 9094 / 2051 / 4630）。
//   但样本量小，不得宣称识别率，因此保留 AI 视觉与手动两条兜底路径。
//
// 识别顺序由 solveCaptcha() 编排：OCR → AI → null（交由调用方手动填入）。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

// 本地 DSH 模型网关（与 ds-bot 的 antigravity provider 同一端点，Anthropic Messages 协议）
const VISION_ENDPOINT = process.env.MEDBRIEF_VISION_ENDPOINT || 'http://127.0.0.1:8045/v1/messages'
const VISION_MODEL = process.env.MEDBRIEF_VISION_MODEL || 'gemini-3.5-flash-lite'
const TESSERACT = process.env.MEDBRIEF_TESSERACT || 'tesseract'

const CAPTCHA_LEN = 4

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args)
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', () => resolve({ ok: false, out: '', err: 'spawn failed' }))
    p.on('close', (code) => resolve({ ok: code === 0, out, err }))
    if (input) p.stdin.end(input)
  })
}

function isDigits(s) {
  return typeof s === 'string' && s.length === CAPTCHA_LEN && /^\d{4}$/.test(s)
}

// ---------- ① 纯 OCR：整图 ----------
async function ocrWholeImage(imagePath) {
  const tmp = imagePath.replace(/\.png$/i, '.whole.png')
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(imagePath)}).convert('RGB')
im = im.resize((im.width*6, im.height*6), Image.LANCZOS)
im.save(${JSON.stringify(tmp)})
`
  const r = await run('python3', ['-c', py])
  if (!r.ok) return null
  let hit = null
  for (const psm of ['8', '13', '7', '6']) {
    const o = await run(TESSERACT, [tmp, 'stdout', '--psm', psm, '-c', 'tessedit_char_whitelist=0123456789'])
    const s = (o.out || '').replace(/\s/g, '')
    if (isDigits(s)) { hit = s; break }
  }
  try { fs.unlinkSync(tmp) } catch {}
  return hit
}

// ---------- ② 纯 OCR：逐色分离（本项目验证码的强先验：一数字一纯色） ----------
// 每个数字是单一纯色，按颜色聚类后按字形质心从左到右排序，能规避干扰线跨字粘连。
async function ocrByColor(imagePath) {
  const outJson = imagePath.replace(/\.png$/i, '.colors.json')
  const cropDir = path.dirname(imagePath)
  const py = `
import json, subprocess, sys
from collections import Counter, deque
from PIL import Image
import numpy as np

img = Image.open(${JSON.stringify(imagePath)}).convert('RGB')
a = np.array(img)
h, w = a.shape[:2]
cnt = Counter(map(tuple, a.reshape(-1, 3)))
# 背景为白色，取非白且像素数较多的颜色（实测字形色约 600-800 px）
colors = [c for c, n in cnt.most_common(12) if c != (255, 255, 255) and n > 200]

def largest_component(mask):
    seen = np.zeros_like(mask, dtype=bool)
    best = []
    for y in range(mask.shape[0]):
        for x in range(mask.shape[1]):
            if mask[y, x] and not seen[y, x]:
                q = deque([(y, x)]); seen[y, x] = True; pts = []
                while q:
                    cy, cx = q.popleft(); pts.append((cy, cx))
                    for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True; q.append((ny, nx))
                if len(pts) > len(best):
                    best = pts
    return best

results = []
for c in colors:
    mask = (np.abs(a.astype(int) - np.array(c)).sum(axis=2) < 60)
    comp = largest_component(mask)
    if len(comp) < 80:
        continue
    ys = [p[0] for p in comp]; xs = [p[1] for p in comp]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    cx = sum(xs) / len(xs)
    pad = 6
    sub = mask[max(0, y0-pad):y1+pad+1, max(0, x0-pad):x1+pad+1]
    if sub.size == 0:
        continue
    up = Image.fromarray((sub * 255).astype(np.uint8))
    up = up.resize((sub.shape[1]*6, sub.shape[0]*6), Image.LANCZOS)
    fn = ${JSON.stringify(cropDir)} + '/.cap_digit_' + str(x0) + '.png'
    up.save(fn)
    outs = {}
    for psm in ('10', '8', '7'):
        r = subprocess.run(['${TESSERACT}', fn, 'stdout', '--psm', psm, '-c', 'tessedit_char_whitelist=0123456789'],
                           capture_output=True, text=True)
        outs[psm] = r.stdout.strip()
    results.append({'cx': cx, 'x0': x0, 'x1': x1, 'color': list(c), 'ocr': outs})

results.sort(key=lambda r: r['cx'])
print(json.dumps(results))
`
  const r = await run('python3', ['-c', py])
  if (!r.ok) return null
  let rows
  try {
    rows = JSON.parse(r.out.trim().split('\n').pop())
  } catch {
    return null
  }
  if (!Array.isArray(rows) || rows.length !== CAPTCHA_LEN) return null
  const chars = []
  for (const row of rows) {
    const ch = row.ocr?.['8'] || row.ocr?.['10'] || row.ocr?.['7'] || ''
    if (!/^\d$/.test(ch)) return null
    chars.push(ch)
  }
  const code = chars.join('')
  // 清理单字裁剪临时图（保留原始验证码图，便于人工复核）
  for (const row of rows) {
    try { fs.unlinkSync(path.join(cropDir, `.cap_digit_${row.x0}.png`)) } catch {}
  }
  return isDigits(code) ? code : null
}

// ---------- ③ AI 视觉识别（本地 DSH 模型网关） ----------
export async function solveCaptchaWithAI(imagePath, { timeoutMs = 45000 } = {}) {
  let b64
  try {
    b64 = fs.readFileSync(imagePath).toString('base64')
  } catch {
    return { code: null, error: 'image read failed' }
  }
  const payload = {
    model: VISION_MODEL,
    max_tokens: 24,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: '这是4位数字图形验证码，数字带随机颜色和干扰线。只输出这4个数字，不要任何其他文字、标点或空格。' },
      ],
    }],
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(VISION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { code: null, error: `vision http ${res.status}: ${t.slice(0, 200)}` }
    }
    const json = await res.json()
    const text = (json.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    const digits = (text.match(/\d/g) || []).join('')
    if (isDigits(digits)) return { code: digits, raw: text, model: json.model || VISION_MODEL }
    return { code: null, raw: text, error: 'not 4 digits' }
  } catch (e) {
    return { code: null, error: String(e.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 编排：OCR → AI → null ----------
// 返回 { code, method, attempts }；code 为 null 表示前两路都失败，调用方应转手动填入。
export async function solveCaptcha(imagePath, { allowAI = true } = {}) {
  const attempts = []

  const byColor = await ocrByColor(imagePath).catch(() => null)
  attempts.push({ method: 'ocr-color', code: byColor })
  if (byColor) return { code: byColor, method: 'ocr-color', attempts }

  const whole = await ocrWholeImage(imagePath).catch(() => null)
  attempts.push({ method: 'ocr-whole', code: whole })
  if (whole) return { code: whole, method: 'ocr-whole', attempts }

  if (allowAI) {
    const ai = await solveCaptchaWithAI(imagePath)
    attempts.push({ method: 'ai-vision', code: ai.code, error: ai.error })
    if (ai.code) return { code: ai.code, method: 'ai-vision', attempts, raw: ai.raw }
  }

  return { code: null, method: 'manual-required', attempts }
}

export const captchaConfig = {
  visionEndpoint: VISION_ENDPOINT,
  visionModel: VISION_MODEL,
  length: CAPTCHA_LEN,
}
