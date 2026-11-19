import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { partners, rooms, roomName, type Card, type Identity } from '../assistant/contracts.ts'
import styles from './assistant.css?raw'

const api = '/orchestrator/api/assistant'
async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(api+path,{ method:input ? 'POST' : 'GET', headers:{'x-orchestrator-request':'1','content-type':'application/json'},
    ...(input ? {body:JSON.stringify(input)} : {}) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '连接失败。')
  return data
}
function Avatar({ id, greet=false }: { id: string; greet?: boolean }) {
  if (id === 'team') return <span className="stack">{partners.map(p => <Avatar key={p.id} id={p.id}/>)}</span>
  return <i aria-hidden="true" className={'peb '+(partners.find(p => p.id === id)?.color ?? '')+(greet?' greet':'')}/>
}
function initialRoom() { try { const r=localStorage.getItem('superagent:last-room'); if (r && rooms.includes(r)) return r } catch {} return 'team' }

export function Assistant({ children }: { children: ReactNode }) {
  const [room,changeRoom] = useState(initialRoom), [list,setList] = useState(false), [advanced,setAdvanced] = useState(false)
  const [cards,setCards] = useState<Card[]>([]), [inputs,setInputs] = useState<Record<string,string>>({}), [error,setError] = useState('')
  const [tools,setTools] = useState(false), [about,setAbout] = useState(false), [busy,setBusy] = useState(false)
  const [connection,setConnection] = useState(''), [edit,setEdit] = useState<{id:string;body:string;previous:string}|null>(null)
  const active = useRef(room), seq = useRef(0), scroll = useRef<HTMLDivElement>(null), follow = useRef(true)
  const unsent = useRef<{room:string;text:string;id:string}|null>(null)
  const input = inputs[room] || ''
  const setInput = (value:string) => setInputs(old => ({...old,[room]:value}))
  const load = useCallback(async () => {
    const id = ++seq.current, rows = await request<Card[]>('/'+room)
    if (active.current === room && id === seq.current) setCards(rows)
  },[room])
  useEffect(() => {
    let alive=true
    const poll=()=>{ void load().catch(() => { if(alive) setError('暂时连不上助手，恢复后会自动刷新。') }) }
    poll(); const timer=setInterval(poll,2000)
    return () => {alive=false;clearInterval(timer);seq.current++}
  },[load])
  const last=cards.at(-1)
  useEffect(() => { if(follow.current && scroll.current) scroll.current.scrollTop=scroll.current.scrollHeight },[last?.id,last?.body,last?.state])
  function select(id:string) {
    active.current=id; seq.current++; changeRoom(id);setCards([]);setEdit(null);setAbout(false);setList(false);setError('');setTools(false);follow.current=true
    try {localStorage.setItem('superagent:last-room',id)} catch {}
    if(id===room) void load().catch(()=>{})
  }
  async function action(job:()=>Promise<void>) {
    setError('');setBusy(true)
    try { await job(); if(active.current===room) await load() }
    catch(e) {if(active.current===room) setError(e instanceof Error ? e.message : '请求失败。')}
    finally {setBusy(false)}
  }
  const submit = async () => {
    if(!input.trim() || busy) return
    const text=input.trim(), past=unsent.current
    const id=past?.text===text && past.room===room ? past.id : crypto.randomUUID()
    unsent.current={id,room,text};follow.current=true
    await action(async()=>{await request('',{op:'message',room,id,text});unsent.current=null;setInputs(old=>old[room]?.trim()===text?{...old,[room]:''}:old)})
  }
  function cardAction(c:Card, act:string) { void action(async()=>{await request('',{op:'card',room,id:c.id,action:act,previous:edit?.id===c.id ? edit.previous : c.body,body:edit?.id===c.id?edit.body:undefined});setEdit(null)}) }
  async function connect(retry?: Card) {
    await action(async()=>{
      let data=await request<{installed:boolean;account:Identity|null}>('',{op:'connection'})
      if(!data.installed) {setConnection('当前 profile 尚未启用钉钉插件。');return}
      if(!data.account) data=await request('',{op:'login'})
      if(!data.account) throw new Error('请完成 DWS 登录后再试。')
      setConnection('已连接 · '+data.account.name)
      if(retry) await request('',{op:'retry',room,id:retry.id})
    })
  }
  if(advanced) return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><button onClick={()=>setAdvanced(false)}>‹ 返回个人助手</button><div style={{flex:1,minHeight:0,overflow:'auto'}}>{children}</div></div>
  return <div className="sa-assistant" data-list={list}><style>{styles}</style><aside>
    <span className="small">伙伴</span><div className="pins">{partners.map(p=><button key={p.id} className="pin" aria-current={room===p.id} title={p.role} onClick={()=>select(p.id)}><Avatar id={p.id}/>{p.name}</button>)}</div>
    <span className="small">群聊</span><button className="group" aria-current={room==='team'} onClick={()=>select('team')}><Avatar id="team"/>助手群</button>
    <div className="space"><button disabled={busy} onClick={()=>void connect()}>连接钉钉</button>{connection&&<span className="small">{connection}</span>}<button onClick={()=>setAdvanced(true)}>高级管理</button></div>
  </aside><main><header><button className="back" onClick={()=>setList(true)}>‹ 伙伴</button><button className="pill" onClick={()=>setAbout(!about)}><Avatar key={room} id={room} greet/>{roomName(room)} ﹀</button></header>
    {about&&<div className="tools">{partners.filter(p=>room==='team'||room===p.id).map(p=><button key={p.id} onClick={()=>select(p.id)}>{p.name} · {p.role}</button>)}</div>}
    <div ref={scroll} className="scroll" onScroll={e=>{const s=e.currentTarget;follow.current=s.scrollHeight-s.scrollTop-s.clientHeight<90}}>
    {!cards.length&&<div className="empty"><Avatar id={room}/><span>{room==='team'?'和伙伴们聊聊':'和'+roomName(room)+'聊聊'}</span></div>}
    {cards.map(c=><article key={c.id} className={c.author==='me'?'mine':''}>{c.kind==='incoming'?<span className="human">{c.author.slice(0,1)}</span>:c.author!=='me'&&<Avatar id={c.author}/>}
      <div className="copy" data-bot={c.author}>{c.author!=='me'&&<div className="small">{c.kind==='incoming'?c.author:roomName(c.author)}</div>}
      <div className="bubble">{c.title&&<div>{c.title}</div>}{c.account&&<span className="small">钉钉 · {c.account}{c.target?' → '+c.target:''}</span>}
      {edit?.id===c.id?<textarea aria-label="群消息正文" rows={3} value={edit.body} onChange={e=>setEdit({...edit,body:e.target.value})}/>:c.kind==='document'&&c.state==='done'?<details><summary>阅读文档</summary><p>{c.body}</p></details>:c.body&&<p>{c.body}</p>}
      {['planning','pending','working','sending'].includes(c.state)&&<span className="small">处理中…</span>}
      <div className="draft-actions">{c.state==='draft'&&(edit?.id===c.id?<><button disabled={busy} onClick={()=>cardAction(c,'edit')}>保存修改</button><button onClick={()=>setEdit(null)}>放弃修改</button></>:<><button disabled={busy} onClick={()=>cardAction(c,'confirm')}>确认发送</button><button onClick={()=>setEdit({id:c.id,previous:c.body,body:c.body})}>编辑</button><button disabled={busy} onClick={()=>cardAction(c,'cancel')}>取消发送</button></>)}
      {c.state==='watching'&&<button disabled={busy} onClick={()=>cardAction(c,'stop')}>停止关注</button>}
      {c.state==='connect'&&<button disabled={busy} onClick={()=>void connect(c)}>连接并继续</button>}
      {c.state==='retry'&&<button disabled={busy} onClick={()=>void action(async()=>{await request('',{op:'retry',room,id:c.id})})}>重试</button>}</div></div></div></article>)}</div>
    {error&&<div className="notice" role="alert">{error}</div>}
    {tools&&<div className="tools">{['查今天的日程','读文档《','约同事开会','发到工作群','留意同事回复'].map(t=><button key={t} onClick={()=>{setInput(t);setTools(false)}}>{t}</button>)}</div>}
    <form className="composer" onSubmit={e=>{e.preventDefault();void submit()}}><button type="button" aria-label="快捷输入" onClick={()=>setTools(!tools)}>＋</button>
    <textarea rows={1} value={input} aria-label="消息" placeholder={'给'+roomName(room)+'发消息'} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit()}}}/>
    <button disabled={!input.trim()||busy} aria-label="发送">↑</button></form></main></div>
}
