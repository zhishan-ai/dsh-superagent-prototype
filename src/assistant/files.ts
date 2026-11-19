import { createHash, randomUUID } from 'node:crypto'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { assistantLimits, type AssistantFile } from './contracts.ts'

const { fileBytes, fileCount, messageFileBytes } = assistantLimits
export const fileRequestBytes = 4 * Math.ceil(messageFileBytes / 3) + 96 * 1024
export const uploadFiles = z.array(z.object({
  name: z.string().trim().min(1).max(255),
  data: z.string().max(4 * Math.ceil(fileBytes / 3)),
})).max(fileCount)
type Upload = z.infer<typeof uploadFiles>
type Storage = Pick<AttachmentStore, 'saveFile' | 'readFileStream'>
export interface StoredFile extends AssistantFile { ref: FileAttachmentRef; excerpt?: string }
export type FileContext = Omit<StoredFile, 'id' | 'ref'>

export function fileSignature(files: Upload) {
  return files.length ? createHash('sha256').update(JSON.stringify(files)).digest('hex') : undefined
}

function safeName(name: string) {
  return name.split(/[/\\]/u).at(-1)?.replace(/[\u0000-\u001F\u007F]/gu, '').trim() || '附件'
}

function readText(name: string, data: Buffer) {
  if (!/\.(?:txt|md|markdown|csv|tsv|json|ya?ml|log)$/iu.test(name)) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return text.includes('\0') ? undefined : text
  } catch { return undefined }
}

export async function storeFiles(storage: Storage | undefined, uploads: Upload): Promise<StoredFile[]> {
  if (!uploads.length) return []
  if (!storage) throw new Error('当前 DSH 未启用附件存储')
  const files = uploads.map(file => {
    const data = Buffer.from(file.data, 'base64')
    if (data.byteLength > fileBytes || data.toString('base64') !== file.data) throw new Error('附件编码无效或大于 512 KiB')
    const name = safeName(file.name)
    return { name, data, text: readText(name, data) }
  })
  if (files.reduce((total, file) => total + file.data.byteLength, 0) > messageFileBytes) throw new Error('单条消息的附件总大小不能超过 1 MiB')
  const excerptLimit = Math.floor(12_000 / Math.max(1, files.filter(file => file.text !== undefined).length))
  const stored: StoredFile[] = []
  for (const file of files) {
    const ref = await storage.saveFile({ name: file.name, data: file.data })
    stored.push({ id: randomUUID(), name: ref.name, bytes: ref.bytes, ref, readable: file.text !== undefined,
      truncated: file.text !== undefined && file.text.length > excerptLimit, excerpt: file.text?.slice(0, excerptLimit) })
  }
  return stored
}

export async function readDownload(storage: Storage | undefined, file: StoredFile) {
  if (!storage) throw new Error('当前 DSH 未启用附件存储')
  const chunks: Uint8Array[] = []
  for await (const chunk of storage.readFileStream(file.ref)) chunks.push(chunk)
  return { name: file.name, data: Buffer.concat(chunks).toString('base64') }
}

export function fileView({ ref: _ref, excerpt: _excerpt, ...view }: StoredFile): AssistantFile { return view }

export function fileContext({ id: _id, ref: _ref, ...context }: StoredFile): FileContext { return context }
