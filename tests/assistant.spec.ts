import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AssistantDesk } from '../src/assistant/desk.ts'
import type { Workspace } from '../src/assistant/contracts.ts'
import { planner, type Plan } from '../src/assistant/planner.ts'

const start='2026-11-20T15:00:00+08:00', end='2026-11-20T15:30:00+08:00'
const mandate='请发会邀给林悦', request=mandate+'，并草拟群通知、留意林悦回复。'
const flow: Plan = { bot:'teal',reply:'',actions:[
  {kind:'agenda',start,end,people:[]}, {kind:'document',query:'排期'}, {kind:'invite',start,end,title:'排期评审',people:['林悦'],mandate},
  {kind:'draft',group:'项目群',body:'周五评审'}, {kind:'watch',group:'项目群',person:'林悦'},
] }
function fixture() {
  const db=new DatabaseSync(':memory:'), account={id:'org:user',name:'许舟 · 栖禾'}
  const service: Workspace={
    account:vi.fn(async()=>account),login:vi.fn(),person:vi.fn(async()=>({id:'staff',name:'林悦'})),
    group:vi.fn(async()=>({id:'cid',name:'项目群'})),agenda:vi.fn(async()=>({events:[{summary:'评审',start,end}]})),
    document:vi.fn(async()=>({title:'排期',content:'第二版'})),busy:vi.fn(),
    invite:vi.fn(async()=>'event-3'),send:vi.fn(async()=>'msg-4'),
    replies:vi.fn(async()=>({messages:[{id:'reply-1',text:'已确认'}],next:''})),
  }
  const plan=vi.fn(async()=>flow)
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
  expect(await route('team','[]',request)).toEqual(flow)
  expect(stream).toHaveBeenCalledWith(expect.objectContaining({provider:'p',model:'m',system:expect.stringContaining('当前会话：助手群')}))
})
