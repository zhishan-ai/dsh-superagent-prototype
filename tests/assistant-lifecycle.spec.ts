import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import type { Workspace } from '../src/assistant/contracts.ts'
import { AssistantDesk } from '../src/assistant/desk.ts'
import type { Plan, Planner } from '../src/assistant/planner.ts'

it('preserves room IDs and history across edits, deletion, restart and restoration', async () => {
  using db = new DatabaseSync(':memory:')
  const plan = vi.fn<Planner>(async (_room, _history, request, context) => ({
    bot: context.target ?? context.partners[0]!.id, reply: `收到：${request}`, actions: [],
  }))
  const desk = new AssistantDesk(db, () => undefined, plan)
  const groupCommand = { op: 'create-group', id: randomUUID(), name: '活动组', members: ['white', 'violet'] }
  const group = 'group-' + groupCommand.id
  try {
    await desk.execute(groupCommand)
    await desk.execute({ op: 'update-partner', id: 'white', name: '日程伙伴', role: '安排活动日期' })
    await desk.execute({ op: 'message', room: group, id: randomUUID(), text: '说说周末安排', mention: 'white' })
    await desk.execute({ op: 'message', room: 'white', id: randomUUID(), text: '一条私聊' })
    await desk.execute({ op: 'delete-partner', id: 'white', room: group })
    expect(() => desk.assertRoom('white')).toThrow('找不到')
    expect(desk.conversation(group)).toMatchObject({
      groups: expect.arrayContaining([expect.objectContaining({ id: group, members: ['violet'] })]),
      removedPartners: [expect.objectContaining({ id: 'white', name: '日程伙伴', role: '安排活动日期', color: '' })],
      cards: expect.arrayContaining([expect.objectContaining({ author: 'white', body: '收到：说说周末安排' })]),
    })
    await expect(desk.execute({ op: 'message', room: group, id: randomUUID(), text: '@日程伙伴 你好' })).rejects.toThrow('当前会话')
    await expect(desk.execute({ op: 'create-partner', name: '日程伙伴', role: '设置一个重复名字' })).rejects.toThrow('已被使用')
    expect(plan).toHaveBeenCalledTimes(2)
    await desk.execute({ op: 'update-group', id: group, name: '换书会', members: ['violet'] })
    expect(await desk.execute({ op: 'delete-group', id: group, room: group })).toMatchObject({ room: 'team' })
    await desk.execute({ op: 'delete-group', id: group })
    expect(() => desk.conversation(group)).toThrow('找不到')
  } finally { await desk.stop() }

  const reopened = new AssistantDesk(db, () => undefined, plan)
  try {
    expect(reopened.conversation('home')).toMatchObject({ room: 'team', deleted: [
      { kind: 'group', id: group, name: '换书会' }, { kind: 'partner', id: 'white', name: '日程伙伴' },
    ] })
    await reopened.execute({ op: 'restore-room', id: 'white' })
    await reopened.execute({ op: 'restore-room', id: group })
    const restored = reopened.conversation(group)
    expect(restored.deleted).toEqual([])
    expect(restored.groups.find(item => item.id === group)).toMatchObject({ name: '换书会', members: expect.arrayContaining(['white', 'violet']) })
    expect(restored.cards.at(-1)).toMatchObject({ author: 'white', body: '收到：说说周末安排' })
    expect(reopened.conversation('white').cards.at(-1)).toMatchObject({ body: '收到：一条私聊' })
  } finally { await reopened.stop() }
})

it('allows an empty roster and blocks new work in groups with no active partner', async () => {
  using db = new DatabaseSync(':memory:')
  const plan = vi.fn<Planner>()
  const desk = new AssistantDesk(db, () => undefined, plan)
  try {
    for (const id of ['white', 'violet', 'teal']) await desk.execute({ op: 'delete-partner', id })
    expect(desk.conversation('home')).toMatchObject({ room: 'home', partners: [], cards: [] })
    expect(desk.conversation('team').groups[0]).toMatchObject({ id: 'team', members: [] })
    await expect(desk.execute({ op: 'message', room: 'team', id: randomUUID(), text: '有人吗' })).rejects.toThrow('没有伙伴')
    expect(plan).not.toHaveBeenCalled()
    await desk.execute({ op: 'delete-group', id: 'team' })
    expect(desk.conversation('home')).toMatchObject({ room: 'home', groups: [] })
    expect(await desk.execute({ op: 'restore-room', id: 'teal' })).toMatchObject({ room: 'teal' })
    expect(await desk.execute({ op: 'restore-room', id: 'team' })).toMatchObject({ room: 'team' })
  } finally { await desk.stop() }
})

it('blocks removing a queued assignee or archiving a running group until work finishes', async () => {
  using db = new DatabaseSync(':memory:')
  const pending = Promise.withResolvers<Plan>()
  const plan: Planner = async (_room, _history, _request, context) => {
    if (context.target === 'white') return pending.promise
    if (context.target === 'violet') return { bot: 'violet', reply: '根据日程写出的通知', actions: [] }
    return { bot: 'white', reply: '', actions: [], work: { title: '活动安排', steps: [
      { id: 'calendar', bot: 'white', title: '安排日期', instructions: '确认日期', dependsOn: [] },
      { id: 'notice', bot: 'violet', title: '写通知', instructions: '使用确定的日期', dependsOn: ['calendar'] },
    ] } }
  }
  const desk = new AssistantDesk(db, () => undefined, plan)
  const completed = { bot: 'white', reply: '周五下午', actions: [] }
  try {
    const request = { op: 'message', room: 'team', id: randomUUID(), text: '安排活动并写通知' }
    await desk.execute(request)
    await expect(desk.execute({ op: 'delete-group', id: 'team' })).rejects.toThrow('正在执行')
    await expect(desk.execute({ op: 'delete-partner', id: 'violet' })).rejects.toThrow('正在执行')
    await expect(desk.execute({ op: 'update-group', id: 'team', name: '活动组', members: ['white', 'teal'] })).rejects.toThrow('正在执行')
    pending.resolve(completed)
    await vi.waitFor(() => expect(desk.conversation('team').work?.[0]?.state).toBe('done'))
    await desk.execute({ op: 'update-group', id: 'team', name: '活动组', members: ['white', 'teal'] })
    expect(desk.conversation('team').groups[0]?.members).toEqual(['white', 'teal'])
    expect(desk.conversation('team').work?.[0]?.steps[1]).toMatchObject({ partner: 'violet', output: '根据日程写出的通知' })
  } finally {
    pending.resolve(completed)
    await desk.stop()
  }
})

it('blocks deletion during a send confirmation and stops a removed partner’s watches', async () => {
  using db = new DatabaseSync(':memory:')
  const account = { id: 'acct', name: '工作账号' }
  const service: Workspace = {
    account: vi.fn(async () => account), login: vi.fn(), person: vi.fn(async () => ({ id: 'staff', name: '小李' })),
    group: vi.fn(async () => ({ id: 'group', name: '工作群' })), agenda: vi.fn(), busy: vi.fn(), document: vi.fn(),
    invite: vi.fn(), send: vi.fn(async () => 'receipt'), replies: vi.fn(async () => ({ messages: [], next: '' })),
  }
  const plan: Planner = async () => ({ bot: 'teal', reply: '', actions: [
    { kind: 'draft', group: '工作群', body: '周五开会' }, { kind: 'watch', group: '工作群', person: '小李' },
  ] })
  const desk = new AssistantDesk(db, () => service, plan)
  const connecting = Promise.withResolvers<typeof account>()
  try {
    await desk.execute({ op: 'message', room: 'team', id: randomUUID(), text: '准备通知，再留意小李的回复' })
    const draft = desk.view('team').find(card => card.state === 'draft')!
    vi.mocked(service.account).mockImplementationOnce(() => connecting.promise)
    const sending = desk.execute({ op: 'card', action: 'confirm', room: 'team', id: draft.id, previous: draft.body })
    try {
      await expect(desk.execute({ op: 'delete-partner', id: 'teal' })).rejects.toThrow('正在执行')
      expect(service.send).not.toHaveBeenCalled()
    } finally { connecting.resolve(account) }
    await sending
    expect(service.send).toHaveBeenCalledOnce()
    await desk.execute({ op: 'delete-partner', id: 'teal' })
    expect(desk.view('team').find(card => card.kind === 'watch')).toMatchObject({ state: 'stopped' })
    await desk.execute({ op: 'restore-room', id: 'teal' })
    await desk.tick()
    expect(service.replies).not.toHaveBeenCalled()
  } finally {
    connecting.resolve(account)
    await desk.stop()
  }
})
