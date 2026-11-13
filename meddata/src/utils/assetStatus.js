// ===================== 原件状态判定（唯一口径） =====================
// 为什么需要这一层：docFileStore.getDocFile / getRecordImage 拿不到 blob 时**一律返回 null**，
// 于是「从来没有原件（手动录入）」「服务端也没有（真缺失）」「离线/服务未起（暂不可读）」
// 三种完全不同的现实，被渲染成同一句「原件缺失或无法预览」，用户无法判断该不该补传。
//
// 判定规则（由调用方把三件事分别喂进来，本模块只做分档与措辞）：
//   ref        实体里有没有原件引用（doc.file.id / record.original_image_id）
//   hasBlob    探测结果：true=取到 / false=确认取不到 / null=还没探测
//   online     数据源是否在线（apiStore.getStatus().online）
//   syncEnabled 是否开启数据源同步；关闭时「本地即权威」，本地没有就是没有
//
// 红线：**没有证据就不要下"已丢失"的结论**。本机无 + 服务端 404 无法区分「真丢」
// 与「从来没上传成功」——快照里实测有一批引用长期处于后者，所以文案只说事实（"未找到"）。

export const ASSET_STATE = {
  OK: 'ok',
  NONE: 'none', // 从来没有原件（手动录入 / 从未上传过就手工建档）
  MISSING: 'missing', // 有引用，但本机 + 服务端都取不到
  UNAVAILABLE: 'unavailable', // 有引用，但数据源连不上，暂时读不到（不代表丢失）
}

// 从实体里取原件引用 id（doc/invoice 走 file.id；record 走 original_image_id；多页走 images[]）
export function assetRefOf(entity) {
  if (!entity || typeof entity !== 'object') return ''
  if (entity.file && typeof entity.file.id === 'string' && entity.file.id) return entity.file.id
  for (const k of ['original_image_id', 'image_id', 'fileId', 'blobId']) {
    if (typeof entity[k] === 'string' && entity[k]) return entity[k]
  }
  if (Array.isArray(entity.images)) {
    for (const x of entity.images) {
      if (typeof x === 'string' && x) return x
      if (x && typeof x.id === 'string' && x.id) return x.id
    }
  }
  return ''
}

export function assetStateOf({ ref, hasBlob = null, online = true, syncEnabled = true } = {}) {
  if (hasBlob === true) return ASSET_STATE.OK
  if (!ref) return ASSET_STATE.NONE
  // 数据源连不上时，取不到 blob 不足以判"缺失"——只能说"暂不可读"
  if (syncEnabled && online === false) return ASSET_STATE.UNAVAILABLE
  // 同步关闭 = 本地即权威；同步开启且在线 = 服务端已明确给不出 → 未找到
  return ASSET_STATE.MISSING
}

const TEXT = {
  [ASSET_STATE.OK]: '',
  [ASSET_STATE.MISSING]: (noun) => `未找到${noun}（本机与服务端都没有）`,
  [ASSET_STATE.UNAVAILABLE]: (noun) => `数据源未连上，${noun}暂不可读`,
}

const TONE = {
  [ASSET_STATE.OK]: '',
  [ASSET_STATE.NONE]: 'text-slate-500',
  [ASSET_STATE.MISSING]: 'text-amber-700',
  [ASSET_STATE.UNAVAILABLE]: 'text-slate-500',
}

// state → 文案 / 色调 / 可做的动作
export function assetStatusOf(entity, opts = {}) {
  const {
    noun = '原件',
    online = true,
    syncEnabled = true,
    hasBlob = null,
    manualLabel = '手动录入',
    // 没有引用时是否视为"人工录入"：化验记录没有 no_file 标记，缺 original_image_id
    // 必然是人工转录/AI 转录取值建出来的，故由调用方声明，避免文案退化成含糊的"未保存"
    noRefIsManual = false,
  } = opts
  const ref = assetRefOf(entity)
  const state = assetStateOf({ ref, hasBlob, online, syncEnabled })
  const manual = (!!entity && entity.no_file === true) || (noRefIsManual && !ref)
  let text = ''
  if (state === ASSET_STATE.NONE) text = manual ? `${manualLabel}，无${noun}` : `未保存${noun}`
  else if (TEXT[state]) text = TEXT[state](noun)
  return {
    state,
    ref,
    text,
    tone: TONE[state],
    canAttach: state !== ASSET_STATE.OK,
    canRetry: state === ASSET_STATE.UNAVAILABLE,
  }
}

// 列表徽标：只表达「有没有」，不表达「连不连得上」——离线时列表里不该冒出噪声。
// hasBlob 由调用方用 apiStore.hasRemoteBlob(ref) 给出：true/false/null(未知=不显示)。
export function assetBadgeOf(entity, { hasBlob = null, noun = '原件' } = {}) {
  const ref = assetRefOf(entity)
  if (!ref) {
    return {
      show: true,
      state: ASSET_STATE.NONE,
      text: `无${noun}`,
      cls: 'bg-slate-100 text-slate-500 border-slate-200',
      hint: `没有${noun}（手动录入/人工转录），详情页可补传`,
    }
  }
  if (hasBlob === false) {
    return {
      show: true,
      state: ASSET_STATE.MISSING,
      text: `${noun}缺失`,
      cls: 'bg-amber-50 text-amber-700 border-amber-200',
      hint: `本机与服务端都没有${noun}，详情页可补传`,
    }
  }
  return { show: false, state: ASSET_STATE.OK, text: '', cls: '', hint: '' }
}
