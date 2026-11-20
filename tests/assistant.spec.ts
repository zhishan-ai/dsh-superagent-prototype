import { backup, DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AssistantDesk } from '../src/assistant/desk.ts'
import { partners, type Workspace } from '../src/assistant/contracts.ts'
import { planner, type Plan, type Planner } from '../src/assistant/planner.ts'

const start='2026-11-20T15:00:00+08:00', end='2026-11-20T15:30:00+08:00'
const mandate='请发会邀给林悦', request=mandate+'，并草拟群通知、留意林悦回复。'
const flow: Plan = { bot:'teal',reply:'',actions:[
  {kind:'agenda',start,end,people:[]}, {kind:'document',query:'排期'}, {kind:'invite',start,end,title:'排期评审',people:['林悦'],mandate},
  {kind:'draft',group:'项目群',body:'周五评审'}, {kind:'watch',group:'项目群',person:'林悦'},
] }
function fixture(customPlan?: Planner) {
  const db=new DatabaseSync(':memory:'), account={id:'org:user',name:'许舟 · 栖禾'}
  const service: Workspace={
    account:vi.fn(async()=>account),login:vi.fn(),person:vi.fn(async()=>({id:'staff',name:'林悦'})),
    group:vi.fn(async()=>({id:'cid',name:'项目群'})),agenda:vi.fn(async()=>({events:[{summary:'评审',start,end}]})),
    document:vi.fn(async()=>({title:'排期',content:'第二版'})),busy:vi.fn(),
    invite:vi.fn(async()=>'event-3'),send:vi.fn(async()=>'msg-4'),
    replies:vi.fn(async()=>({messages:[{id:'reply-1',text:'已确认'}],next:''})),
  }
  const plan=vi.fn<Planner>(customPlan ?? (async()=>flow))
  return {db,account,service,plan,desk:new AssistantDesk(db,()=>service,plan)}
}
it.each(['team','violet'])('runs the five work actions from %s with one login, one invite and an explicit send',async room=>{
  const {desk,service,account,plan}=fixture()
  vi.mocked(service.account).mockResolvedValue(null)
  const msg={op:'message',room,id:randomUUID(),text:request}
  await desk.execute(msg)
  expect(desk.view(room).filter(c=>c.state==='connect')).toHaveLength(5)
  vi.mocked(service.account).mockResolvedValue(account)
  await desk.execute({op:'login'})
  await desk.execute({op:'retry',room,id:desk.view(room)[1]!.id})
  await desk.execute(msg)
  expect(plan).toHaveBeenCalledTimes(1)
  expect(service.invite).toHaveBeenCalledExactlyOnceWith(account.id,'排期评审',start,end,['staff'])
  expect(service.send).not.toHaveBeenCalled()
  const rows=desk.view(room)
  expect(rows.find(c=>c.kind==='document')).toMatchObject({body:'第二版',author:room==='team'?'teal':room})
  expect(rows.find(c=>c.kind==='agenda')?.body).toContain('评审')
  const draft=rows.find(c=>c.kind==='draft')!
  const cmd={op:'card',room,id:draft.id,action:'confirm',previous:draft.body}
  await desk.execute({...cmd,action:'edit',body:'新的正文'})
  await expect(desk.execute(cmd)).rejects.toThrow('变化')
  vi.mocked(service.account).mockResolvedValueOnce({...account,id:'other'})
  await expect(desk.execute({...cmd,previous:'新的正文'})).rejects.toThrow('所属')
  await Promise.allSettled([1,2].map(()=>desk.execute({...cmd,previous:'新的正文'})))
  expect(service.send).toHaveBeenCalledExactlyOnceWith(account.id,'cid','新的正文',draft.id)
  const watch=rows.find(c=>c.kind==='watch')!
  await new Promise(r=>setTimeout(r,4))
  await desk.tick();await desk.tick()
  expect(desk.view(room).filter(c=>c.kind==='incoming')).toEqual([expect.objectContaining({author:'林悦',body:'已确认'})])
  expect(desk.view(room==='team'?'violet':'team')).toEqual([])
  expect(vi.mocked(service.replies).mock.calls[0]?.slice(0,3)).toEqual([account.id,'cid','staff'])
  await desk.execute({op:'card',room,id:watch.id,action:'stop',previous:''})
  vi.mocked(service.replies).mockClear();await desk.tick();expect(service.replies).not.toHaveBeenCalled()
})
it('recovers uncertain effects without a second send and refuses cross-room edits',async()=>{
  const {db,desk,service,plan}=fixture()
  await desk.execute({op:'message',room:'team',id:randomUUID(),text:request})
  const draft=desk.view('team').find(c=>c.state==='draft')!
  const cmd={op:'card',id:draft.id,action:'confirm',previous:draft.body}
  await expect(desk.execute({...cmd,room:'white'})).rejects.toThrow('找不到')
  db.prepare("UPDATE assistant_card SET state='sending' WHERE id=?").run(draft.id)
  const next=new AssistantDesk(db,()=>service,plan)
  expect(next.view('team').find(c=>c.id===draft.id)?.state).toBe('unknown')
  await next.execute({op:'retry',room:'team',id:draft.id})
  expect(service.send).not.toHaveBeenCalled()
})
it('routes ordinary language through the host model and validates its action plan',async()=>{
  const stream=vi.fn(async function*(){yield {type:'text-delta',text:JSON.stringify(flow)}})
  const route=planner({sessionController:{modelCatalog:async()=>({default:{provider:'p',model:'m'}})},llm:{stream}} as never,new AbortController().signal)
  expect(await route('team','[]',request,{name:'助手群',partners:[...partners]})).toEqual(flow)
  expect(stream).toHaveBeenCalledWith(expect.objectContaining({provider:'p',model:'m',system:expect.stringContaining('当前会话：助手群')}))
})

it('binds a worker result to its assigned partner and asks only for the current delivery', async () => {
  const stream = vi.fn(async function* (_options: { system: string; messages: unknown }) {
    yield { type: 'text-delta', text: JSON.stringify({ reply: '活动物料是琥珀色印花夹。' }) }
  })
  const route = planner({ sessionController: { modelCatalog: async () => ({ default: { provider: 'p', model: 'm' } }) },
    llm: { stream } } as never, new AbortController().signal)
  const context = { name: '换书会', partners: [...partners], target: 'teal',
    files: [{ name: '清单.csv', bytes: 20, readable: true, excerpt: '物料,琥珀色印花夹' }],
    workStep: { title: '整理物料', instructions: '从清单中找出物料', inputs: [] } }
  await expect(route('team', '[]', '请安排两步群内协作', context)).resolves.toEqual({
    bot: 'teal', reply: '活动物料是琥珀色印花夹。', actions: [],
  })
  expect(stream.mock.calls[0]?.[0].system).toContain('消息与跟进')
  expect(JSON.stringify(stream.mock.calls[0]?.[0].messages)).toContain('琥珀色印花夹')
  stream.mockImplementationOnce(async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ reply: '执行了其他操作', actions: [{ kind: 'draft' }] }) }
  })
  await expect(route('team', '[]', '请安排两步群内协作', context)).rejects.toThrow('解析')
})

it('restores added partners, selected group members, and their messages from the existing SQLite store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-assistant-'))
  const path = join(directory, 'orchestrator.sqlite')
  let db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE assistant_card (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}');
      INSERT INTO assistant_card (id,room,author,kind,state,title,body) VALUES ('legacy','team','teal','text','done','','原来的聊天');`)

    const stream = vi.fn(async function* (_options: { system: string }) {
      yield { type: 'text-delta', text: JSON.stringify({ bot: 'white', reply: '我来列物料清单。', actions: [] }) }
    })
    const plan = planner({
      sessionController: { modelCatalog: async () => ({ default: { provider: 'p', model: 'm' } }) },
      llm: { stream },
    } as never, new AbortController().signal)
    const desk = new AssistantDesk(db, () => undefined, plan)
    const createPartner = { op: 'create-partner', id: randomUUID(), name: '木槿', role: '负责活动物料' }
    const created = await desk.execute(createPartner)
    const partner = desk.conversation('team').partners.find(p => p.name === createPartner.name)!
    expect(partner).toMatchObject({ role: createPartner.role })
    expect(created).toMatchObject({ room: partner.id, cards: [] })
    expect(await desk.execute(createPartner)).toMatchObject({ room: partner.id })
    await expect(desk.execute({ ...createPartner, id: randomUUID() })).rejects.toThrow()

    const createGroup = { op: 'create-group', id: randomUUID(), name: '活动筹备', members: [partner.id, 'white'] }
    expect(() => desk.execute({ ...createGroup, members: [partner.id, partner.id] })).toThrow()
    await expect(desk.execute({ ...createGroup, members: [partner.id, 'missing'] })).rejects.toThrow()
    const groupResult = await desk.execute(createGroup)
    const group = desk.conversation('team').groups.find(g => g.name === createGroup.name)!
    expect(groupResult).toMatchObject({ room: group.id, cards: [] })
    expect(await desk.execute(createGroup)).toMatchObject({ room: group.id })
    expect(new Set(group.members)).toEqual(new Set(createGroup.members))

    const message = { op: 'message', id: randomUUID(), room: group.id, text: '@木槿 帮忙列一下物料。' }
    await expect(desk.execute({ ...message, mention: 'teal' })).rejects.toThrow()
    await expect(desk.execute({ ...message, text: '@青团 帮忙列一下物料。' })).rejects.toThrow()
    expect(desk.conversation(group.id).cards).toEqual([])
    expect(stream).not.toHaveBeenCalled()
    await desk.execute({ ...message, mention: partner.id })
    expect(stream).toHaveBeenCalledOnce()
    const system = stream.mock.calls[0]![0].system
    expect(system).toContain(createPartner.role)
    expect(system).toContain(`本轮由 ID 为 ${partner.id} 的伙伴回复`)
    expect(system).not.toContain('消息与跟进')
    expect(desk.conversation(group.id).cards.at(-1)).toMatchObject({ author: partner.id, body: '我来列物料清单。' })

    await desk.stop()
    db.close()
    db = new DatabaseSync(path)
    const next = new AssistantDesk(db, () => undefined, plan)
    expect(next.conversation(group.id)).toMatchObject({
      room: group.id, groups: expect.arrayContaining([group]), partners: expect.arrayContaining([partner]),
      cards: [expect.objectContaining({ author: 'me', body: message.text }), expect.objectContaining({ author: partner.id, body: '我来列物料清单。' })],
    })
    expect(next.conversation('team').cards).toEqual([expect.objectContaining({ id: 'legacy', body: '原来的聊天' })])
    expect(next.conversation(partner.id).cards).toEqual([])

    await next.execute({ ...message, id: randomUUID() })
    expect(next.conversation(group.id).cards.at(-1)).toMatchObject({ author: partner.id, body: '我来列物料清单。' })

    stream.mockImplementationOnce(async function* () {
      yield { type: 'text-delta', text: JSON.stringify({ bot: 'teal', reply: '外部伙伴的答复', actions: [] }) }
    })
    const unpinned = { ...message, id: randomUUID(), text: '还需要准备什么？' }
    await next.execute(unpinned)
    expect(next.conversation(group.id).cards.at(-1)).toMatchObject({ id: unpinned.id, author: 'me', state: 'retry' })
    await next.stop()
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('routes independent group steps and releases the handoff only after both results are ready', async () => {
  using db = new DatabaseSync(':memory:')
  const date = Promise.withResolvers<Plan>()
  const materials = Promise.withResolvers<Plan>()
  const role = '整理活动物料'
  let partnerId = ''
  const plan = vi.fn<Planner>(async (_room, _history, _request, context) => {
    const result = { bot: context.target ?? 'white', reply: '', actions: [] }
    if (!context.workStep) return { ...result, work: { title: '筹备换书会', steps: [
      { id: 'draft', bot: 'violet', title: '撰写邀请', instructions: '根据时间和物料来写', dependsOn: ['date', 'materials'] },
      { id: 'date', bot: 'white', title: '确定日期', instructions: '建议活动日期', dependsOn: [] },
      { id: 'materials', bot: partnerId, title: '物料清单', instructions: '列出三项物料', dependsOn: [] },
    ] } }
    if (context.target === 'white') return date.promise
    if (context.target === partnerId) return materials.promise
    return { ...result, reply: '周六见，请自带书籍。' }
  })
  const desk = new AssistantDesk(db, () => undefined, plan)
  try {
    await desk.execute({ op: 'create-partner', name: '木槿', role })
    partnerId = desk.conversation('team').partners.find(p => p.name === '木槿')!.id
    await desk.execute({ op: 'create-group', name: '换书会', members: ['white', 'violet', partnerId] })
    const room = desk.conversation('team').groups.find(g => g.name === '换书会')!.id
    const message = { op: 'message', room, id: randomUUID(), text: '请三位分工筹备换书会，定日期、列清单，再写邀请。' }
    await desk.execute(message)
    const contexts = () => plan.mock.calls.map(call => call[3])

    await vi.waitFor(() => expect(contexts().filter(c => c.workStep)).toHaveLength(2))
    expect(contexts().find(c => c.target === partnerId)?.partners).toContainEqual(expect.objectContaining({ id: partnerId, role }))
    expect(desk.conversation(room).work).toEqual([expect.objectContaining({ requestId: message.id, state: 'running', steps: expect.arrayContaining([
      expect.objectContaining({ id: 'date', state: 'running' }),
      expect.objectContaining({ id: 'materials', state: 'running' }),
      expect.objectContaining({ id: 'draft', state: 'waiting' }),
    ]) })])
    expect(contexts().some(c => c.target === 'violet')).toBe(false)

    date.resolve({ bot: 'white', reply: '本周六 15 点。', actions: [] })
    await vi.waitFor(() => expect(desk.conversation(room).work?.[0]?.steps.find(s => s.id === 'date')?.state).toBe('done'))
    expect(contexts().some(c => c.target === 'violet')).toBe(false)
    materials.resolve({ bot: partnerId, reply: '物料包括桌椅、标牌和书签。', actions: [] })

    await vi.waitFor(() => expect(desk.conversation(room).work?.[0]?.state).toBe('done'))
    const final = contexts().find(c => c.target === 'violet')!
    expect(final.workStep).toMatchObject({ title: '撰写邀请', instructions: '根据时间和物料来写', inputs: expect.arrayContaining([
      expect.objectContaining({ title: '确定日期', output: '本周六 15 点。' }),
      expect.objectContaining({ title: '物料清单', output: '物料包括桌椅、标牌和书签。' }),
    ]) })
    expect(final.partners.some(p => p.id === 'teal')).toBe(false)
    expect(desk.conversation(room).work?.[0]?.steps.find(s => s.id === 'draft')).toMatchObject({
      partner: 'violet', state: 'done', output: '周六见，请自带书籍。',
    })
    expect(desk.conversation('team').work ?? []).toEqual([])
    await desk.execute(message)
    expect(plan).toHaveBeenCalledTimes(4)
  } finally {
    date.resolve({ bot: 'white', reply: '日期', actions: [] })
    materials.resolve({ bot: partnerId, reply: '物料', actions: [] })
    await desk.stop()
  }
})

const workStep = (id: string, bot: string, dependsOn: string[]) => ({ id, bot, dependsOn, title: id, instructions: '完成该步骤' })

it('supplies completed group deliveries to a later mention from the same room', async () => {
  using db = new DatabaseSync(':memory:')
  const work = { title: '换书会通知', steps: [workStep('facts', 'white', []), workStep('draft', 'violet', ['facts'])] }
  const followUp = '@栗子 请将刚交付的通知缩成一句。'
  const draft = '请到北侧第三柜领取 17 份折页，核对码 QA-714。'
  const otherOutputs = new Map([
    ['另一群的分工', '另一群的内部成果'],
    ['未完成的分工', '还不能作为已交付成果'],
  ])
  const plan = vi.fn<Planner>(async (_room, _history, request, context) => {
    if (request === followUp) return { bot: 'violet', reply: '改写完成。', actions: [] }
    if (!context.workStep) return { bot: 'white', reply: '', actions: [], work }
    if (request === '未完成的分工' && context.target === 'violet') throw new Error('模型暂时不可用')
    const reply = otherOutputs.get(request) ?? (context.target === 'violet' ? draft : '折页共 17 份。')
    return { bot: context.target!, reply, actions: [] }
  })
  const desk = new AssistantDesk(db, () => undefined, plan)
  const send = (assistant: AssistantDesk, room: string, text: string, mention?: string) =>
    assistant.execute({ op: 'message', room, id: randomUUID(), text, mention })
  try {
    await desk.execute({ op: 'create-group', name: '独立群', members: ['white', 'violet'] })
    const otherRoom = desk.conversation('team').groups.find(group => group.name === '独立群')!.id
    await send(desk, otherRoom, '另一群的分工')
    await send(desk, 'team', '请分工准备换书会通知。')
    await vi.waitFor(() => expect(desk.conversation('team').work?.[0]?.state).toBe('done'))
    await send(desk, 'team', '未完成的分工')
    await vi.waitFor(() => expect(desk.conversation('team').work?.[1]?.state).toBe('failed'))
    await vi.waitFor(() => expect(desk.conversation(otherRoom).work?.[0]?.state).toBe('done'))
  } finally {
    await desk.stop()
  }

  const reopened = new AssistantDesk(db, () => undefined, plan)
  try {
    await send(reopened, 'team', followUp, 'violet')
    const call = plan.mock.calls.find(([, , request]) => request === followUp)
    expect(call?.[3].target).toBe('violet')
    expect(JSON.parse(call![1])).toEqual([
      ['me', '', '请分工准备换书会通知。'],
      ['white', '已完成分工《换书会通知》 · facts', '折页共 17 份。'],
      ['violet', '已完成分工《换书会通知》 · draft', draft],
      ['me', '', '未完成的分工'],
    ])
  } finally {
    await reopened.stop()
  }
})

it('resumes an interrupted group handoff and retries failed steps without rerunning completed work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-assistant-handoff-'))
  const snapshot = join(directory, 'interrupted.sqlite')
  const outstanding = Promise.withResolvers<Plan>()
  using db = new DatabaseSync(':memory:')
  const work = { title: '活动安排', steps: [workStep('outline', 'white', []), workStep('draft', 'violet', ['outline'])] }
  const plan: Planner = async (_room, _history, _request, context) => {
    if (!context.workStep) return { bot: 'white', reply: '', actions: [], work }
    if (context.target === 'white') return { bot: 'white', reply: '议程已列好。', actions: [] }
    return outstanding.promise
  }
  const desk = new AssistantDesk(db, () => undefined, plan)
  const reply = { bot: 'violet', reply: '根据议程拟好了通知。', actions: [] }
  try {
    const message = { op: 'message', room: 'team', id: randomUUID(), text: '请两位分工制定活动安排，然后拟通知。' }
    await desk.execute(message)
    await vi.waitFor(() => expect(desk.conversation('team').work?.[0]?.steps[1]?.state).toBe('running'))
    await backup(db, snapshot)
    outstanding.resolve(reply)
    await desk.stop()

    using recoveredDb = new DatabaseSync(snapshot)
    const recoveredPlanner = vi.fn<Planner>().mockRejectedValueOnce(new Error('模型暂时不可用')).mockResolvedValueOnce(reply)
    const recovered = new AssistantDesk(recoveredDb, () => undefined, recoveredPlanner)
    try {
      recovered.resumeGroupWork()
      await vi.waitFor(() => expect(recovered.conversation('team').work?.[0]?.state).toBe('failed'))
      const restored = recovered.conversation('team').work![0]!
      expect(restored).toMatchObject({ requestId: message.id, steps: [
        expect.objectContaining({ id: 'outline', state: 'done', output: '议程已列好。' }),
        expect.objectContaining({ id: 'draft', state: 'failed' }),
      ] })
      await recovered.execute({ op: 'retry-work', room: 'team', id: restored.id })
      await vi.waitFor(() => expect(recovered.conversation('team').work?.[0]?.state).toBe('done'))
      expect(recoveredPlanner).toHaveBeenCalledTimes(2)
      for (const call of recoveredPlanner.mock.calls) expect(call[3]).toMatchObject({ target: 'violet', workStep: {
        inputs: [expect.objectContaining({ output: '议程已列好。' })],
      } })
      expect(recovered.conversation('team').work?.[0]?.steps[1]?.output).toBe(reply.reply)
    } finally {
      await recovered.stop()
    }
  } finally {
    outstanding.resolve(reply)
    await desk.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([
  { reason: 'a cycle', steps: [workStep('one', 'white', ['two']), workStep('two', 'violet', ['one'])] },
  { reason: 'a missing dependency', steps: [workStep('one', 'white', ['missing']), workStep('two', 'violet', [])] },
  { reason: 'a partner outside the group', steps: [workStep('one', 'white', []), workStep('two', 'teal', ['one'])] },
])('does not dispatch group plans with $reason', async ({ steps }) => {
  using db = new DatabaseSync(':memory:')
  const plan = vi.fn<Planner>(async () => ({ bot: 'white', reply: '', actions: [], work: { title: '分工', steps } }))
  const desk = new AssistantDesk(db, () => undefined, plan)
  try {
    await desk.execute({ op: 'create-group', name: '校验分工', members: ['white', 'violet'] })
    const room = desk.conversation('team').groups.find(g => g.name === '校验分工')!.id
    const message = { op: 'message', room, id: randomUUID(), text: '请安排小组分工。' }
    await desk.execute(message)
    expect(plan).toHaveBeenCalledOnce()
    expect(desk.conversation(room).work ?? []).toEqual([])
    expect(desk.conversation(room).cards).toEqual([expect.objectContaining({ id: message.id, state: 'retry' })])
  } finally {
    await desk.stop()
  }
})

it('does not run multi-partner plans from a private chat or delegate a pinned request past its named partner', async () => {
  using db = new DatabaseSync(':memory:')
  const plan = vi.fn<Planner>(async () => ({ bot: 'white', reply: '', actions: [], work: { title: '分工', steps: [
    workStep('one', 'violet', []), workStep('two', 'white', ['one']),
  ] } }))
  const desk = new AssistantDesk(db, () => undefined, plan)
  try {
    const text = '请安排相关工作。'
    await desk.execute({ op: 'message', room: 'white', id: randomUUID(), text })
    await desk.execute({ op: 'message', room: 'team', mention: 'white', id: randomUUID(), text: '@小白 ' + text })
    expect(plan).toHaveBeenCalledTimes(2)
    expect(desk.conversation('white').work ?? []).toEqual([])
    expect(desk.conversation('team').work ?? []).toEqual([])
  } finally {
    await desk.stop()
  }
})

it('leaves DingTalk actions to the direct request flow rather than dispatching them from a group work plan', async () => {
  const work = { title: '分工', steps: [workStep('one', 'white', []), workStep('two', 'violet', ['one'])] }
  const mixedRequest = '请分工准备通知，同时查日程。'
  const { db, desk, plan, service } = fixture(async (_room, _history, request, context) => {
    if (context.workStep) return { bot: context.target!, reply: '尝试查日程。', actions: [flow.actions[0]!] }
    return { bot: 'white', reply: '', actions: request === mixedRequest ? [flow.actions[0]!] : [], work }
  })
  try {
    await desk.execute({ op: 'message', room: 'team', id: randomUUID(), text: mixedRequest })
    expect(desk.conversation('team').work ?? []).toEqual([])
    expect(desk.conversation('team').cards.at(-1)?.state).toBe('retry')

    await desk.execute({ op: 'message', room: 'team', id: randomUUID(), text: '请分工准备通知。' })
    await vi.waitFor(() => expect(desk.conversation('team').work?.[0]?.state).toBe('failed'))
    expect(desk.conversation('team').work?.[0]?.steps.map(step => step.state)).toEqual(['failed', 'waiting'])
    expect(plan.mock.calls.filter(call => call[3].workStep)).toHaveLength(1)
    expect(service.account).not.toHaveBeenCalled()
    expect(service.agenda).not.toHaveBeenCalled()
  } finally {
    await desk.stop()
    db.close()
  }
})
