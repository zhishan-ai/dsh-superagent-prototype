import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { AttachmentId, type FileAttachmentRef, type SaveFileAttachment } from '@deepseek-ai/dsh-attachment'
import { expect, it, vi } from 'vitest'
import { assistantLimits } from '../src/assistant/contracts.ts'
import { AssistantDesk } from '../src/assistant/desk.ts'
import type { Plan, Planner } from '../src/assistant/planner.ts'

function storageFixture() {
  const dataById = new Map<string, Uint8Array>()
  const saveFile = vi.fn(async ({ name = '附件', data }: SaveFileAttachment) => {
    const attachmentId = AttachmentId(`native-storage-${dataById.size + 1}`)
    dataById.set(attachmentId, Uint8Array.from(data))
    return { attachmentId, name, bytes: data.byteLength }
  })
  const readFileStream = vi.fn(async function* ({ attachmentId }: FileAttachmentRef) {
    const data = dataById.get(attachmentId)
    if (!data) throw new Error('Missing fixture attachment')
    yield data.slice(0, 2)
    yield data.slice(2)
  })
  return { saveFile, readFileStream }
}

const encode = (name: string, data: string | Buffer) => ({ name, data: Buffer.from(data).toString('base64') })
const answer: Plan = { bot: 'white', reply: '收到。', actions: [] }

it('keeps attachment bytes in native storage, exposes public metadata and scopes downloads to the original room', async () => {
  using db = new DatabaseSync(':memory:')
  const storage = storageFixture()
  const plan = vi.fn<Planner>().mockResolvedValue(answer)
  const desk = new AssistantDesk(db, () => undefined, plan, () => storage)
  const privateMarker = '附件中的记录只有提交时才能被读取。'
  const privateText = `${privateMarker}\n第二行`
  const raw = Buffer.from([0xff, 0x00, 0x20, 0x41])
  const files = [encode('other/folder\\笔记.md', privateText), encode('二进制.csv', raw)]
  const message = { op: 'message', room: 'team', id: randomUUID(), text: '', files }
  try {
    const result = await desk.execute(message)
    const cards = desk.conversation('team').cards
    const submitted = cards.find(card => card.id === message.id)!
    const publicFiles = [
      { id: expect.any(String), name: '笔记.md', bytes: Buffer.byteLength(privateText), readable: true, truncated: false },
      { id: expect.any(String), name: '二进制.csv', bytes: raw.length, readable: false, truncated: false },
    ]
    expect(submitted).toMatchObject({ kind: 'user', body: '', state: 'done' })
    expect(submitted.files).toEqual(publicFiles)
    expect(result).toMatchObject({ room: 'team', cards })
    expect(JSON.stringify(result)).not.toContain(privateMarker)
    expect(JSON.stringify(result)).not.toContain('native-storage-')
    expect(plan).toHaveBeenCalledExactlyOnceWith('team', '[]', '', expect.objectContaining({ files: [
      { name: '笔记.md', bytes: Buffer.byteLength(privateText), readable: true, truncated: false, excerpt: privateText },
      { name: '二进制.csv', bytes: raw.length, readable: false, truncated: false },
    ] }))
    expect(storage.saveFile).toHaveBeenNthCalledWith(1, { name: '笔记.md', data: Buffer.from(privateText) })

    const [first, second] = submitted.files!
    await expect(desk.download('white', first!.id)).rejects.toMatchObject({ status: 404 })
    expect(storage.readFileStream).not.toHaveBeenCalled()
    await expect(desk.download('team', first!.id)).resolves.toEqual({ name: '笔记.md', data: files[0]!.data })
    await expect(desk.download('team', second!.id)).resolves.toEqual({ name: '二进制.csv', data: files[1]!.data })

    await expect(desk.execute(message)).resolves.toMatchObject({ cards })
    await expect(desk.execute({ ...message, files: [encode('笔记.md', '已替换')] })).rejects.toThrow('消息标识冲突')
    expect(storage.saveFile).toHaveBeenCalledTimes(2)
    expect(plan).toHaveBeenCalledOnce()

    await desk.execute({ op: 'message', room: 'team', id: randomUUID(), text: '以后再看这个附件。' })
    expect(plan.mock.calls[1]?.[3].files).toBeUndefined()
    expect(plan.mock.calls[1]?.[1]).not.toContain(privateMarker)
    await desk.execute({ op: 'message', room: 'white', id: randomUUID(), text: '另一个会话。' })
    expect(plan.mock.calls[2]?.[3].files).toBeUndefined()
    expect(desk.conversation('white').cards.every(card => !card.files)).toBe(true)
  } finally {
    await desk.stop()
  }
})

it('retries an interrupted response using the original attachment without another upload', async () => {
  using db = new DatabaseSync(':memory:')
  const storage = storageFixture()
  const plan = vi.fn<Planner>().mockRejectedValueOnce(new Error('暂不可用')).mockResolvedValueOnce(answer)
  const desk = new AssistantDesk(db, () => undefined, plan, () => storage)
  const text = '提取材料要点。'
  const message = { op: 'message', room: 'white', id: randomUUID(), text, files: [encode('材料.txt', '项目信息')] }
  try {
    await desk.execute(message)
    const initial = desk.conversation('white').cards[0]!
    expect(initial).toMatchObject({ id: message.id, state: 'retry' })
    await desk.execute(message)
    expect(plan).toHaveBeenCalledOnce()
    await desk.execute({ op: 'retry', room: 'white', id: message.id })
    expect(plan).toHaveBeenCalledTimes(2)
    expect(plan.mock.calls[1]?.slice(2)).toEqual([text, plan.mock.calls[0]?.[3]])
    expect(storage.saveFile).toHaveBeenCalledOnce()
    expect(desk.conversation('white').cards[0]).toMatchObject({ state: 'done', files: initial.files })
  } finally {
    await desk.stop()
  }
})

it('validates the complete attachment batch before it writes files or creates a message', async () => {
  using db = new DatabaseSync(':memory:')
  const storage = storageFixture()
  const plan = vi.fn<Planner>().mockResolvedValue(answer)
  const desk = new AssistantDesk(db, () => undefined, plan, () => storage)
  const submit = async (files: { name: string; data: string }[]) => desk.execute({
    op: 'message', room: 'team', id: randomUUID(), text: '', files,
  })
  try {
    await expect(submit([])).rejects.toThrow('请填写消息或选择附件')
    await expect(submit([encode('有效.txt', '有效'), { name: '无效.txt', data: '!' }])).rejects.toThrow('编码无效')
    await expect(submit([encode('太大.bin', Buffer.alloc(assistantLimits.fileBytes + 1))])).rejects.toThrow()
    const maxFile = Buffer.alloc(assistantLimits.fileBytes)
    await expect(submit([encode('一.bin', maxFile), encode('二.bin', maxFile), encode('三.bin', 'x')])).rejects.toThrow('附件总大小')
    expect(storage.saveFile).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
    expect(desk.conversation('team').cards).toEqual([])
  } finally {
    await desk.stop()
  }
})
