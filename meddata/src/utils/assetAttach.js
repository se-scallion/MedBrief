// 原件补传：把用户手上的原始文件重新挂回实体（doc / invoice / record）
// 使用场景：详情页显示「未找到原件」时的唯一可行动作（原件在用户手上或相册里）。
import { saveDocFile, saveRecordImage } from './docFileStore.js'
import { fileFingerprint } from './fileHash.js'
import { updateDoc, writeRecord } from '../data/store.js'

// 文书 / 检查报告 / 发票：写 docFileStore 的 f_ blob，再挂到 doc.file
export async function attachDocFile(doc, file) {
  if (!doc || !file) return null
  const blobId = await saveDocFile(file)
  // ⚠ 文件名参与归档查重键（date + doc_type + file_name）：原来有名字就沿用，
  // 否则同一份报告将来重新导入会被判成"新报告"。
  const name = (doc.file && doc.file.name) || file.name || `${doc.date || ''}_${doc.doc_type || 'doc'}`
  // 补传同样要落原件哈希：否则这条归档永远缺「字节通道」，同一份原件再导入仍会漏判重复。
  const sha256 = (await fileFingerprint(file)) || ''
  updateDoc(doc.id, {
    file: { id: blobId, name, size: file.size, mime: file.type || '', sha256 },
    no_file: false,
  })
  return blobId
}

// 化验 / 流式 / 骨髓记录：写 record_images 的 r_ blob，再挂到 record.original_image_id
export async function attachRecordImage(record, file) {
  if (!record || !file) return null
  const imgId = await saveRecordImage(file)
  writeRecord({ id: record.id, patch: { original_image_id: imgId }, source: 'manual' })
  return imgId
}
