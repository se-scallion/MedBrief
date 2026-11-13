/**
 * 运行时补丁的校验与应用（零依赖纯函数，可被浏览器 / node / 单测直接调用）。
 *
 * 为什么单独一层而不写进 dictionary.js：
 *  - `dictionary.js` / `parseDoc.js` / `ocr.js` 三处都要应用各自那一"片"补丁，
 *    共用同一套校验/合并语义，避免三份实现漂移；
 *  - 纯函数 + sink 注入 → 不 import 任何业务模块，不会形成循环依赖。
 *
 * 安全底线（对应 patches.js 铁律 3）：本文件所有函数都不抛异常给调用方；
 * 调用方仍应 try/catch 兜底一次，防止结构被外部改坏。
 */

export const PATCH_ALLOWED_KEYS = [
  'id',
  'note',
  'fields',
  'aliases',
  'keyFields',
  'sections',
  'definingCodes',
]

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验单条补丁。返回 { ok, errors[] }。
 * 只做结构与类型校验；业务安全（ref 中心偏移、变体吞并实测）仍走 ORC 工作流 §5.3。
 */
export function validatePatch(p) {
  const errors = []
  if (!isPlainObject(p)) return { ok: false, errors: ['补丁必须是对象'] }
  if (!String(p.id || '').trim()) errors.push('缺少 id')
  for (const k of Object.keys(p)) {
    if (FORBIDDEN_KEYS.has(k)) errors.push(`禁止的键：${k}`)
  }
  if (p.fields !== undefined) {
    if (!Array.isArray(p.fields)) errors.push('fields 必须是数组')
    else {
      p.fields.forEach((f, i) => {
        if (!isPlainObject(f)) return errors.push(`fields[${i}] 必须是对象`)
        if (!String(f.code || '').trim()) errors.push(`fields[${i}] 缺少 code`)
        if (!String(f.name || '').trim()) errors.push(`fields[${i}] 缺少 name`)
      })
    }
  }
  for (const key of ['aliases', 'keyFields']) {
    const v = p[key]
    if (v === undefined) continue
    if (!isPlainObject(v)) {
      errors.push(`${key} 必须是对象`)
      continue
    }
    for (const [code, list] of Object.entries(v)) {
      if (!String(code || '').trim()) errors.push(`${key} 存在空 code`)
      if (!Array.isArray(list)) errors.push(`${key}.${code} 必须是数组`)
      else if (list.some((x) => typeof x !== 'string' || !x.trim())) {
        errors.push(`${key}.${code} 含空值或非字符串`)
      }
    }
  }
  if (p.sections !== undefined) {
    if (!isPlainObject(p.sections)) errors.push('sections 必须是对象')
    else {
      for (const [k, list] of Object.entries(p.sections)) {
        if (!Array.isArray(list)) errors.push(`sections.${k} 必须是数组`)
      }
    }
  }
  if (p.definingCodes !== undefined && !Array.isArray(p.definingCodes)) {
    errors.push('definingCodes 必须是数组')
  }
  return { ok: errors.length === 0, errors }
}

const pushUnique = (arr, vals) => {
  if (!Array.isArray(arr) || !Array.isArray(vals)) return 0
  let n = 0
  for (const v of vals) {
    if (typeof v !== 'string' || !v.trim()) continue
    if (!arr.includes(v)) {
      arr.push(v)
      n++
    }
  }
  return n
}

/**
 * 应用补丁到指定的"数据槽"（sink）。所有 sink 字段都可省略，省略的片会被跳过。
 *
 * @param {any[]} patches 补丁列表
 * @param {{
 *   fields?: any[],                                        // STANDARD_FIELDS
 *   fieldByCode?: Record<string, any>,                     // FIELD_BY_CODE（源码优先判据）
 *   aliasMap?: Record<string, string[]>,                   // ALIAS_MAP
 *   reportTypes?: any[],                                   // REPORT_TYPES
 *   sections?: { findings?: string[], conclusion?: string[], exclude?: string[] },
 *   definingCodes?: Set<string>,                           // REPORT_TYPE_DEFINING_CODES
 * }} sink
 * @returns {{ applied: number, skipped: number, errors: string[], notes: string[] }}
 */
export function applyPatches(patches, sink = {}) {
  const out = { applied: 0, skipped: 0, errors: [], notes: [] }
  const list = Array.isArray(patches) ? patches : []
  for (const p of list) {
    const v = validatePatch(p)
    if (!v.ok) {
      out.skipped++
      out.errors.push(`跳过补丁 ${p && p.id ? p.id : '(无 id)'}：${v.errors.join('；')}`)
      continue
    }
    let touched = 0

    // 1) 新增字段：源码已有同 code → 源码优先（跳过并记 note），避免补丁盖住源码
    if (Array.isArray(p.fields) && Array.isArray(sink.fields)) {
      for (const f of p.fields) {
        const code = String(f.code).trim()
        if (sink.fieldByCode && sink.fieldByCode[code]) {
          out.notes.push(`字段 ${code} 已存在于源码，补丁跳过（源码优先）`)
          continue
        }
        sink.fields.push(f)
        if (sink.fieldByCode) sink.fieldByCode[code] = f
        touched++
      }
    }

    // 2) 别名：逐条去重合并
    if (isPlainObject(p.aliases) && isPlainObject(sink.aliasMap)) {
      for (const [code, aliases] of Object.entries(p.aliases)) {
        const cur = Array.isArray(sink.aliasMap[code]) ? sink.aliasMap[code] : []
        const n = pushUnique(cur, aliases)
        if (n) {
          sink.aliasMap[code] = cur
          touched += n
        }
      }
    }

    // 3) 报告类型关键字段：类型必须已存在（不存在 = 类型本身要另走 reportCatalog 的 ALIASES/signature）
    if (isPlainObject(p.keyFields) && Array.isArray(sink.reportTypes)) {
      for (const [typeCode, codes] of Object.entries(p.keyFields)) {
        const rt = sink.reportTypes.find((t) => t && t.code === typeCode)
        if (!rt) {
          out.errors.push(`keyFields.${typeCode}：REPORT_TYPES 无此类型（需先补类型或走 catalog）`)
          continue
        }
        if (!Array.isArray(rt.keyFields)) rt.keyFields = []
        touched += pushUnique(rt.keyFields, codes)
      }
    }

    // 4) doc 段落名
    if (isPlainObject(p.sections) && isPlainObject(sink.sections)) {
      for (const kind of ['findings', 'conclusion', 'exclude']) {
        if (Array.isArray(p.sections[kind]) && Array.isArray(sink.sections[kind])) {
          touched += pushUnique(sink.sections[kind], p.sections[kind])
        }
      }
    }

    // 5) 类型定义码
    if (Array.isArray(p.definingCodes) && sink.definingCodes instanceof Set) {
      for (const code of p.definingCodes) {
        if (typeof code === 'string' && code.trim() && !sink.definingCodes.has(code)) {
          sink.definingCodes.add(code)
          touched++
        }
      }
    }

    if (touched) out.applied++
    else out.skipped++
  }
  return out
}
