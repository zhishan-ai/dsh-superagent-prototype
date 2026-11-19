import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { assistantLimits, type AssistantView, type Card, type Group, type GroupWork, type Identity, type Partner } from '../assistant/contracts.ts'
import { ApiError } from './api.ts'
import { MarkdownText } from './widgets.tsx'
import styles from './assistant.css?raw'

const api = '/orchestrator/api/assistant'
const home = 'home'
async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(api+path,{ method:input ? 'POST' : 'GET', headers:{'x-orchestrator-request':'1','content-type':'application/json'},
    ...(input ? {body:JSON.stringify(input)} : {}) })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new ApiError(data?.error || '连接失败。', response.status, { unreachable: !data })
  return data
}

function Avatar({ partner, greet = false }: { partner?: Partner; greet?: boolean }) {
  return <i aria-hidden="true" className={`peb ${partner?.color ?? ''}${greet ? ' greet' : ''}`}/>
}
function GroupAvatar({ members }: { members: Partner[] }) {
  return <span className="stack" aria-hidden="true">{members.slice(0, 3).map(p => <Avatar key={p.id} partner={p}/>)}</span>
}

const workStatus = { running: '进行中', done: '已完成', failed: '未完成' }
const stepStatus = { waiting: '待执行', running: '进行中', done: '已完成', failed: '失败' }

function WorkCard({ work, partnerById, busy, onRetry }: {
  work: GroupWork
  partnerById: (id: string) => Partner | undefined
  busy: boolean
  onRetry: () => void
}) {
  const finished = work.steps.filter(step => step.state === 'done').length
  const steps = new Map(work.steps.map(step => [step.id, step]))
  return <details className="work-card" data-work-id={work.id}>
    <summary>
      <span className="work-heading">
        <span className="work-title">{work.title}</span>
        <span className="work-status small" data-state={work.state} role="status">
          {workStatus[work.state]} · {finished}/{work.steps.length}
        </span>
      </span>
      <span className="work-disclosure">
        <span className="work-reveal">查看分工</span><span className="work-hide">收起分工</span>
        <span className="work-chevron" aria-hidden="true">›</span>
      </span>
    </summary>
    <ol className="work-steps" role="list">
      {work.steps.map(step => {
        const partner = partnerById(step.partner)
        const name = partner?.name ?? '伙伴'
        const blocked = step.state === 'waiting' && work.state === 'failed'
        return <li className="work-step" key={step.id}>
          <div className="work-step-head">
            <Avatar partner={partner}/>
            <span className="work-heading">
              <span className="work-title">{step.title}</span>
              <span className="small">{name}</span>
            </span>
            <span className="work-status small" data-state={step.state}>{blocked ? '未执行' : stepStatus[step.state]}</span>
          </div>
          {!!step.dependsOn.length && <ul className="work-handoffs" role="list">
            {step.dependsOn.map(id => {
              const source = steps.get(id)
              if (!source) return null
              const sourceName = partnerById(source.partner)?.name ?? '伙伴'
              let label = '等待交接'
              if (source.state === 'done') label = step.state === 'waiting' ? '成果已就绪' : '已交接'
              else if (source.state === 'failed' || blocked) label = '未交接'
              return <li className="small" key={id}>{label} · {sourceName} → {name} · {source.title}</li>
            })}
          </ul>}
          {step.output && (step.state === 'done'
            ? <MarkdownText className="work-result message-markdown" text={step.output}/>
            : <p className="work-result" data-state={step.state}>{step.output}</p>)}
        </li>
      })}
    </ol>
    {work.state === 'failed' && <div className="work-actions">
      <button type="button" disabled={busy} onClick={onRetry}>重试任务</button>
    </div>}
  </details>
}

function savedRoom() {
  try { return localStorage.getItem('superagent:last-room') || home } catch { return home }
}
function saveRoom(id: string) {
  try { localStorage.setItem('superagent:last-room', id) } catch {}
}

function ConversationDialog({ title, saving, onClose, children }: {
  title: string
  saving: boolean
  onClose: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog} className="creation-dialog" aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); if (!saving) onClose() }}
    onClick={e => { if (e.currentTarget === e.target && !saving) onClose() }}>
    <section className="creation-sheet">
      <div className="creation-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="round" aria-label="关闭" disabled={saving} onClick={onClose}>×</button>
      </div>
      {children}
    </section>
  </dialog>
}

type RoomSettings = { kind: 'partner'; room: Partner } | { kind: 'group'; room: Group }
type DeletedRoom = NonNullable<AssistantView['deleted']>[number]

function ConversationFields({ group, partners, saving, firstField, settings }: {
  group: boolean
  partners: readonly Partner[]
  saving: boolean
  firstField: Ref<HTMLInputElement>
  settings?: RoomSettings
}) {
  const selected = settings?.kind === 'group' ? settings.room.members : []
  return <fieldset disabled={saving} className="creation-fields">
    <label>{group ? '群名' : '名字'}
      <input ref={firstField} name="name" required maxLength={group ? 32 : 16} autoComplete="off" defaultValue={settings?.room.name}/>
    </label>
    {group ? <fieldset className="creation-members">
      <legend>选择伙伴 <span className="small">{settings ? '变更成员需至少两位' : '至少两位'}</span></legend>
      {partners.map(p => <label className="member-choice" key={p.id}>
        <input type="checkbox" name="members" value={p.id} aria-label={p.name} defaultChecked={selected.includes(p.id)}/>
        <Avatar partner={p}/>
        <span>{p.name}<small className="small">{p.role}</small></span>
      </label>)}
    </fieldset> : <label>角色
      <textarea name="role" required maxLength={80} rows={2} placeholder="平时想让它帮什么忙？"
        defaultValue={settings?.kind === 'partner' ? settings.room.role : undefined}/>
    </label>}
  </fieldset>
}

function conversationValues(form: HTMLFormElement, group: boolean, previousMembers?: string[]) {
  const fields = new FormData(form)
  const name = String(fields.get('name') ?? '').trim()
  if (group) {
    const members = fields.getAll('members').map(String)
    const unchanged = previousMembers?.length === members.length && members.every(id => previousMembers.includes(id))
    if (!name || (members.length < 2 && !unchanged)) throw new Error('填写群名，再选择至少两位伙伴')
    return { name, members }
  }
  const role = String(fields.get('role') ?? '').trim()
  if (!name || !role) throw new Error('请填写名字和角色')
  return { name, role }
}

function CreationDialog({ partners, onClose, onCreate, initialMode = 'menu' }: {
  partners: readonly Partner[]
  onClose: () => void
  onCreate: (created: AssistantView) => void
  initialMode?: 'menu' | 'partner'
}) {
  const [mode, setMode] = useState<'menu' | 'partner' | 'group'>(initialMode)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)
  const attempt = useRef<{ key: string; id: string }>()
  const group = mode === 'group'
  useEffect(() => { firstField.current?.focus() }, [mode])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    try {
      const body = { op: group ? 'create-group' : 'create-partner', ...conversationValues(event.currentTarget, group) }
      const key = JSON.stringify(body)
      if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
      setError('')
      setSaving(true)
      onCreate(await request<AssistantView>('', { ...body, id: attempt.current.id }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败，请重试')
      setSaving(false)
    }
  }

  return <ConversationDialog title={mode === 'menu' ? '新建' : group ? '新群聊' : '新伙伴'} saving={saving} onClose={onClose}>
      {mode === 'menu' ? <div className="creation-menu">
        <button type="button" onClick={() => setMode('partner')}>新伙伴 <span aria-hidden="true">›</span></button>
        <button type="button" onClick={() => setMode('group')}>新群聊 <span aria-hidden="true">›</span></button>
      </div> : <form className="creation-form" onSubmit={e => void submit(e)}>
        <ConversationFields group={group} partners={partners} saving={saving} firstField={firstField}/>
        {error && <p className="creation-error" role="alert">{error}</p>}
        <button className="create-submit" type="submit" disabled={saving}>
          {saving ? '创建中…' : group ? '创建群聊' : '创建伙伴'}
        </button>
      </form>}
  </ConversationDialog>
}

function SettingsDialog({ settings, partners, onClose, onChange }: {
  settings: RoomSettings
  partners: readonly Partner[]
  onClose: () => void
  onChange: (view: AssistantView) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const firstField = useRef<HTMLInputElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const group = settings.kind === 'group'
  const label = group ? '群聊' : '伙伴'
  const { id, name } = settings.room
  useEffect(() => { (confirming ? cancel.current : firstField.current)?.focus() }, [confirming])

  async function apply(body: object) {
    if (saving) return
    setError('')
    setSaving(true)
    try { onChange(await request<AssistantView>('', body)) }
    catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试')
      setSaving(false)
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const members = settings.kind === 'group' ? settings.room.members : undefined
      void apply({ op: group ? 'update-group' : 'update-partner', id, ...conversationValues(event.currentTarget, group, members) })
    }
    catch (e) { setError(e instanceof Error ? e.message : '请检查资料') }
  }

  return <ConversationDialog title={confirming ? '删除' + label : label + '设置'} saving={saving}
    onClose={() => { if (confirming) { setConfirming(false); setError('') } else onClose() }}>
    <form className="creation-form" onSubmit={save} hidden={confirming}>
      <ConversationFields group={group} partners={partners} saving={saving} firstField={firstField} settings={settings}/>
      {!confirming && error && <p className="creation-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button className="create-submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        <button className="danger-action" type="button" disabled={saving} onClick={() => {
          setError(''); setConfirming(true)
        }}>删除{label}</button>
      </div>
    </form>
    {confirming && <>
      <p className="delete-copy">删除「{name}」？已发送的消息会保留。可从最近删除恢复。</p>
      {error && <p className="creation-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button ref={cancel} type="button" disabled={saving} onClick={() => { setConfirming(false); setError('') }}>取消</button>
        <button type="button" className="danger-action" disabled={saving} onClick={() => {
          void apply({ op: group ? 'delete-group' : 'delete-partner', id, room: id })
        }}>{saving ? '删除中…' : '确认删除'}</button>
      </div>
    </>}
  </ConversationDialog>
}

function RecentlyDeleted({ removed, onClose, onRestore }: {
  removed: DeletedRoom[]
  onClose: () => void
  onRestore: (view: AssistantView) => void
}) {
  const [restoring, setRestoring] = useState('')
  const [error, setError] = useState('')
  async function restore(id: string) {
    setRestoring(id)
    setError('')
    try { onRestore(await request<AssistantView>('', { op: 'restore-room', id, room: id })) }
    catch (e) {
      setRestoring('')
      setError(e instanceof Error ? e.message : '恢复失败，请重试')
    }
  }
  return <ConversationDialog title="最近删除" saving={!!restoring} onClose={onClose}>
    {removed.length ? <ul className="removed-rooms" role="list">
      {removed.map(item => <li key={item.id}>
        <span>{item.name}<small className="small">{item.kind === 'group' ? '群聊' : '伙伴'}</small></span>
        <button type="button" disabled={!!restoring} aria-label={'恢复 ' + item.name} onClick={() => void restore(item.id)}>
          {item.id === restoring ? '恢复中…' : '恢复'}
        </button>
      </li>)}
    </ul> : <p className="small delete-copy">暂无删除的伙伴或群聊</p>}
    {error && <p className="creation-error" role="alert">{error}</p>}
  </ConversationDialog>
}

interface DraftFile { id: string; file: File }
interface Draft { text: string; mention?: string; files?: DraftFile[] }
type AttachedFile = NonNullable<Card['files']>[number]
async function fileContents(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer().catch(() => { throw new Error('无法读取附件：' + file.name) }))
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}
function attachmentSize(bytes: number) {
  return bytes < 1024 ? bytes + ' B' : Math.ceil(bytes / 1024) + ' KiB'
}

function AttachmentChip({ file, room, onError }: {
  file: AttachedFile
  room: string
  onError: (message: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const description = useId()
  async function download() {
    setLoading(true)
    onError('')
    try {
      const payload = await request<{ name: string; data: string }>('/' + encodeURIComponent(room) + '/files/' + encodeURIComponent(file.id))
      const bytes = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = payload.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch {
      onError('下载失败，请重新点按附件')
    } finally {
      setLoading(false)
    }
  }
  return <button type="button" className="attachment-chip" disabled={loading} aria-label={'下载 ' + file.name} aria-describedby={description}
    title={file.name} onClick={() => void download()}>
    <span className="attachment-label">
      <span>{file.name}</span>
      <small className="small" id={description}>
        {loading ? '下载中…' : attachmentSize(file.bytes)}
        {!file.readable ? ' · 已存档，助手暂不能读取' : ''}
        {file.truncated ? ' · 助手仅读取部分内容' : ''}
      </small>
    </span>
    <span aria-hidden="true">↓</span>
  </button>
}
interface MentionRange { start: number; end: number; query: string }
function mentionRange(value: string, cursor: number): MentionRange | null {
  const match = /(?:^|[^a-z\d_])[@＠]([^@＠\r\n]*)$/iu.exec(value.slice(0, cursor))
  if (!match) return null
  const query = match[1] ?? ''
  return { start: cursor - query.length - 1, end: cursor, query }
}
function containsMention(text: string, name: string) {
  const token = '@' + name
  let index = text.indexOf(token)
  while (index !== -1) {
    const previous = text.slice(0, index)
    const following = text.slice(index + token.length)
    if (!/[a-z\d_]$/i.test(previous) && (!following || /^[\s\p{P}]/u.test(following))) return true
    index = text.indexOf(token, index + token.length)
  }
  return false
}

export function Assistant({ children }: { children: ReactNode }) {
  const [room,changeRoom] = useState(savedRoom), [list,setList] = useState(false), [advanced,setAdvanced] = useState(false)
  const [view,setView] = useState<AssistantView | null>(null)
  const [drafts,setDrafts] = useState<Record<string,Draft>>({})
  const [error,setError] = useState(''), [loadError,setLoadError] = useState('')
  const [tools,setTools] = useState(false), [about,setAbout] = useState(false), [busy,setBusy] = useState(false)
  const [creating,setCreating] = useState<'menu' | 'partner' | null>(null)
  const [settings,setSettings] = useState<RoomSettings | null>(null)
  const [recentlyDeleted,setRecentlyDeleted] = useState(false)
  const [attachmentError,setAttachmentError] = useState('')
  const [draggingFiles,setDraggingFiles] = useState(false)
  const [mention,setMention] = useState<MentionRange | null>(null)
  const [mentionIndex,setMentionIndex] = useState(0)
  const mentionId = useId()
  const [connection,setConnection] = useState(''), [edit,setEdit] = useState<{id:string;body:string;previous:string}|null>(null)
  const active = useRef(room), seq = useRef(0), scroll = useRef<HTMLDivElement>(null), follow = useRef(true)
  const composer = useRef<HTMLDivElement>(null)
  const messageInput = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const desiredCaret = useRef<{ room: string; text: string; offset: number } | null>(null)
  const selectedMention = useRef<HTMLButtonElement>(null)
  const unsent = useRef<(Draft & { room: string; id: string }) | null>(null)
  const partners = view?.partners ?? []
  const groups = view?.groups ?? []
  const activeGroup = groups.find(g => g.id === room)
  const partnerById = (id: string) => partners.find(p => p.id === id) ?? view?.removedPartners?.find(p => p.id === id)
  const membersOf = (group: Group) => group.members.flatMap(id => {
    const partner = partners.find(p => p.id === id)
    return partner ? [partner] : []
  })
  const currentPartner = partners.find(p => p.id === room)
  const currentName = activeGroup?.name ?? currentPartner?.name ?? '会话'
  const members = activeGroup ? membersOf(activeGroup) : []
  const aboutMembers = currentPartner ? [currentPartner] : members
  const draft = drafts[room] ?? { text: '' }
  const input = draft.text
  const files = draft.files ?? []
  const ready = view?.room === room && room !== home
  const canAttach = ready && view.fileUploads !== false
  const hasGroupMembers = !activeGroup || members.length > 0
  const canSend = ready && hasGroupMembers && !busy && !!(input.trim() || files.length)
  const sameDraft = (value: Draft | undefined) => value?.text.trim() === input.trim()
    && value?.mention === draft.mention && value?.files === draft.files
  const canRetrySend = error && unsent.current?.room === room && sameDraft(unsent.current)
  const setDraft = (value: Partial<Draft>) => setDrafts(old => ({ ...old, [room]: { text: '', ...old[room], ...value } }))
  const candidates = mention ? members.filter(p => p.name.toLowerCase().startsWith(mention.query.normalize('NFC').toLowerCase())) : []
  const cards = view?.room === room ? view.cards : []
  const work = view?.room === room ? view.work ?? [] : []
  const requestIds = new Set(cards.map(card => card.id))

  const load = useCallback(async () => {
    const id = ++seq.current
    try {
      const snapshot = await request<AssistantView>('/' + encodeURIComponent(room))
      if (typeof snapshot.room !== 'string' || !Array.isArray(snapshot.cards)) throw new Error('会话信息暂不可用')
      if (active.current === room && id === seq.current) {
        setView(snapshot)
        setLoadError('')
        if (snapshot.room !== room) {
          active.current = snapshot.room
          saveRoom(snapshot.room)
          changeRoom(snapshot.room)
        }
      }
    } catch (e) {
      if (active.current === room && id === seq.current) throw e
    }
  },[room])
  useEffect(() => {
    let alive=true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try { await load() }
      catch (e) {
        if (!alive || active.current !== room) return
        if (e instanceof ApiError && e.missing && room !== home) {
          active.current = home
          saveRoom(home)
          changeRoom(home)
          return
        }
        setLoadError('暂时连不上助手，恢复后会自动刷新')
      }
      if (alive) timer = setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer); seq.current++ }
  },[load,room])
  useEffect(() => {
    if (!mention) return
    function dismiss(event: PointerEvent) {
      if (composer.current && !event.composedPath().includes(composer.current)) setMention(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  },[mention])
  useEffect(() => { selectedMention.current?.scrollIntoView({ block: 'nearest' }) }, [mentionIndex])
  useLayoutEffect(() => {
    const desired = desiredCaret.current
    const field = messageInput.current
    if (!desired) return
    desiredCaret.current = null
    if (!field || desired.room !== room || field.value !== desired.text) return
    field.focus()
    field.setSelectionRange(desired.offset, desired.offset)
  }, [room, input, mention])
  const last=cards.at(-1)
  const workProgress = work.map(item => [item.id, item.state, ...item.steps.map(step => step.state)].join(':')).join(',')
  useEffect(() => { if(follow.current && scroll.current) scroll.current.scrollTop=scroll.current.scrollHeight },[room,last?.id,last?.body,last?.state,workProgress])
  function select(id: string, snapshot?: AssistantView) {
    if (active.current !== id || snapshot) seq.current++
    active.current = id
    changeRoom(id)
    if (snapshot) { setView(snapshot); setLoadError('') }
    setEdit(null)
    setAbout(false)
    setList(false)
    setError('')
    setAttachmentError('')
    setDraggingFiles(false)
    setTools(false)
    setMention(null)
    desiredCaret.current = null
    follow.current = true
    saveRoom(id)
  }
  async function action(job:()=>Promise<void>) {
    setError('');setBusy(true)
    try { await job(); if(active.current===room) await load() }
    catch(e) {if(active.current===room) setError(e instanceof Error ? e.message : '请求失败。')}
    finally {setBusy(false)}
  }
  const renderWork = (item: GroupWork) => <WorkCard key={item.id} work={item} partnerById={partnerById} busy={busy}
    onRetry={() => void action(async () => { await request('', { op: 'retry-work', room, id: item.id }) })}/>
  const submit = async () => {
    if (!canSend) return
    const text = input.trim(), past = unsent.current
    const mention = draft.mention
    const id = past?.room === room && sameDraft(past) ? past.id : crypto.randomUUID()
    unsent.current = { id, room, text, mention, files: draft.files }
    follow.current = true
    setMention(null)
    setAttachmentError('')
    await action(async () => {
      const uploaded = files.length ? await Promise.all(files.map(async ({ file }) => ({ name: file.name, data: await fileContents(file) }))) : undefined
      await request('', { op: 'message', room, id, text, mention, files: uploaded })
      unsent.current = null
      setDrafts(old => sameDraft(old[room]) ? { ...old, [room]: { text: '' } } : old)
    })
  }
  function addFiles(incoming: FileList) {
    if (!ready || !incoming.length) return
    if (!canAttach) { setAttachmentError('当前 DSH 未启用附件存储'); return }
    const next = [...files]
    let bytes = next.reduce((total, item) => total + item.file.size, 0)
    let issue = ''
    for (const file of Array.from(incoming)) {
      if (file.size > assistantLimits.fileBytes) { issue = '单个附件最多 512 KiB'; continue }
      if (next.length >= assistantLimits.fileCount) { issue = '每条消息最多 4 个附件'; break }
      if (bytes + file.size > assistantLimits.messageFileBytes) { issue = '附件合计最多 1 MiB'; continue }
      next.push({ id: crypto.randomUUID(), file })
      bytes += file.size
    }
    if (next.length !== files.length) setDraft({ files: next })
    setAttachmentError(issue)
  }
  function changeInput(value: string, cursor: number) {
    const selected = partnerById(draft.mention ?? '')
    setDraft({ text: value, mention: selected && containsMention(value, selected.name) ? selected.id : undefined })
    setMention(activeGroup ? mentionRange(value, cursor) : null)
    setMentionIndex(0)
  }
  function insertMention(partner: Partner) {
    if (!mention) return
    const token = '@' + partner.name + ' '
    const text = input.slice(0, mention.start) + token + input.slice(mention.end)
    const cursor = mention.start + token.length
    desiredCaret.current = { room, text, offset: cursor }
    setDraft({ text, mention: partner.id })
    setMention(null)
  }
  function pickMention() {
    const start = messageInput.current?.selectionStart ?? input.length
    const end = messageInput.current?.selectionEnd ?? start
    const before = input.slice(0, start)
    const prefix = /[a-z\d_]$/i.test(before) ? ' ' : ''
    const cursor = start + prefix.length + 1
    const text = before + prefix + '@' + input.slice(end)
    desiredCaret.current = { room, text, offset: cursor }
    changeInput(text, cursor)
    setTools(false)
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
  return <div className="sa-assistant" data-list={list}><style>{styles}</style><aside aria-label="伙伴与群聊">
    <div className="side-head">
      <span>伙伴</span>
      <button type="button" className="round" aria-label="新建" aria-haspopup="dialog" onClick={() => setCreating('menu')}>＋</button>
      <button type="button" className="round back" aria-label="回到会话" onClick={() => setList(false)}>×</button>
    </div>
    <div className="side-scroll">
      <div className="pins">{partners.map(p => <button key={p.id} className="pin" aria-current={room === p.id}
        title={p.role} onClick={() => select(p.id)}><Avatar partner={p}/><span>{p.name}</span></button>)}</div>
      <div className="small group-label">群聊</div>
      <div className="groups">{groups.map(g => <button key={g.id} className="group" aria-current={room === g.id} onClick={() => select(g.id)}>
        <GroupAvatar members={membersOf(g)}/><span>{g.name}</span>
      </button>)}</div>
    </div>
    <div className="space">
      <button aria-haspopup="dialog" onClick={() => setRecentlyDeleted(true)}>最近删除</button>
      <button disabled={busy} onClick={()=>void connect()}>连接钉钉</button>
      {connection&&<span className="small">{connection}</span>}
      <button onClick={()=>setAdvanced(true)}>高级管理</button>
    </div>
  </aside><main><header><button className="back" onClick={()=>setList(true)}>‹ 伙伴</button>
    {(activeGroup || currentPartner) && <button className="pill" aria-expanded={about} onClick={()=>setAbout(!about)}>
      {activeGroup ? <GroupAvatar members={members}/> : <Avatar key={room} partner={currentPartner} greet/>}
      <span>{currentName}</span><span aria-hidden="true">﹀</span>
    </button>}
  </header>
    {about && ready && <div className="tools roster" aria-label={activeGroup ? '群成员' : '伙伴角色'}>
      {aboutMembers.map(p => <button key={p.id} onClick={() => select(p.id)}><Avatar partner={p}/><span>{p.name} · {p.role}</span></button>)}
      {activeGroup && <button aria-haspopup="dialog" onClick={() => setSettings({ kind: 'group', room: activeGroup })}>群聊设置</button>}
      {currentPartner && <button aria-haspopup="dialog" onClick={() => setSettings({ kind: 'partner', room: currentPartner })}>伙伴设置</button>}
    </div>}
    <div ref={scroll} className="scroll" onScroll={e=>{const s=e.currentTarget;follow.current=s.scrollHeight-s.scrollTop-s.clientHeight<90}}><div className="conversation-flow">
    {view?.room === home && room === home && <div className="empty">
      <span>还没有会话</span>
      <div className="settings-actions">
        <button className="create-submit" onClick={() => setCreating('partner')}>新建伙伴</button>
        {!!view.deleted?.length && <button onClick={() => setRecentlyDeleted(true)}>恢复伙伴或群聊</button>}
      </div>
    </div>}
    {ready && !cards.length && !work.length && <div className="empty">
      {activeGroup ? <GroupAvatar members={members}/> : <Avatar partner={currentPartner}/>}
      <span>{activeGroup ? '和伙伴们聊聊' : '和' + currentName + '聊聊'}</span>
    </div>}
    {cards.map(c=><Fragment key={c.id}>
      <article className={c.author==='me'?'mine':''}>{c.kind==='incoming'?<span className="human">{c.author.slice(0,1)}</span>:c.author!=='me'&&<Avatar partner={partnerById(c.author)}/>}
      <div className="copy" data-bot={c.author} data-color={c.kind === 'incoming' ? undefined : partnerById(c.author)?.color}>{c.author!=='me'&&<div className="small message-author">{c.kind==='incoming'?c.author:partnerById(c.author)?.name ?? '助手'}</div>}
      <div className="bubble">{c.title&&<div className="message-title">{c.title}</div>}{c.account&&<div className="small message-account">钉钉 · {c.account}{c.target?' → '+c.target:''}</div>}
      {edit?.id===c.id?<textarea aria-label="群消息正文" rows={3} value={edit.body} onChange={e=>setEdit({...edit,body:e.target.value})}/>:c.kind==='document'&&c.state==='done'?<details><summary>阅读文档</summary><p>{c.body}</p></details>:c.body&&(c.kind==='text'&&c.author!=='me'?<MarkdownText className="message-markdown" text={c.body}/>:<p>{c.body}</p>)}
      {!!c.files?.length && <div className="attachment-list">
        {c.files.map(file => <AttachmentChip key={file.id} room={c.room} file={file} onError={setAttachmentError}/>)}
      </div>}
      {['planning','pending','working','sending'].includes(c.state)&&<span className="small">处理中…</span>}
      <div className="draft-actions">{c.state==='draft'&&(edit?.id===c.id?<><button disabled={busy} onClick={()=>cardAction(c,'edit')}>保存修改</button><button onClick={()=>setEdit(null)}>放弃修改</button></>:<><button disabled={busy} onClick={()=>cardAction(c,'confirm')}>确认发送</button><button onClick={()=>setEdit({id:c.id,previous:c.body,body:c.body})}>编辑</button><button disabled={busy} onClick={()=>cardAction(c,'cancel')}>取消发送</button></>)}
      {c.state==='watching'&&<button disabled={busy} onClick={()=>cardAction(c,'stop')}>停止关注</button>}
      {c.state==='connect'&&<button disabled={busy} onClick={()=>void connect(c)}>连接并继续</button>}
      {c.state==='retry'&&<button disabled={busy} onClick={()=>void action(async()=>{await request('',{op:'retry',room,id:c.id})})}>重试</button>}</div></div></div></article>
      {work.filter(item => item.requestId === c.id).map(renderWork)}
    </Fragment>)}
    {work.filter(item => !requestIds.has(item.requestId)).map(renderWork)}
    </div></div>
    {(error || loadError || attachmentError) && <div className="notice">
      <span role="alert">{error || loadError || attachmentError}</span>
      {canRetrySend && <button type="button" disabled={!canSend} onClick={() => void submit()}>重试发送</button>}
    </div>}
    {ready && activeGroup && !hasGroupMembers && <div className="tools roster">
      <span>群聊暂无可用伙伴</span>
      <button onClick={() => setSettings({ kind: 'group', room: activeGroup })}>添加伙伴</button>
    </div>}
    {room !== home && hasGroupMembers && <div className="compose-wrap" ref={composer} onBlur={e => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setMention(null)
    }} onKeyDown={e => {
      if (e.key === 'Escape' && (mention || tools) && !e.nativeEvent.isComposing) {
        setMention(null)
        setTools(false)
        messageInput.current?.focus()
      }
    }} onDragOver={e => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      if (canAttach) { e.dataTransfer.dropEffect = 'copy'; setDraggingFiles(true) }
    }} onDragLeave={e => {
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDraggingFiles(false)
    }} onDrop={e => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDraggingFiles(false)
      addFiles(e.dataTransfer.files)
    }} onPaste={e => {
      if (!e.clipboardData.files.length) return
      if (!e.clipboardData.getData('text/plain')) e.preventDefault()
      addFiles(e.clipboardData.files)
    }}>
      {tools && <div className="tools">
        {activeGroup && <button type="button" onClick={pickMention}>提及伙伴</button>}
        <button type="button" disabled={!canAttach} onClick={() => {
          filePicker.current?.click()
          setTools(false)
          messageInput.current?.focus()
        }}>添加文件</button>
        <span className="small attachment-hint">{view?.fileUploads === false ? '当前 DSH 未启用附件存储' : '可拖放或粘贴。助手可读取 TXT、Markdown、CSV、TSV、JSON、YAML 和 LOG。'}</span>
        {['查今天的日程','读文档《','约同事开会','发到工作群','留意同事回复'].map(t => <button key={t}
          onClick={() => { setDraft({ text: t, mention: undefined }); setTools(false); messageInput.current?.focus() }}>{t}</button>)}
      </div>}
      <input ref={filePicker} type="file" hidden multiple aria-label="添加附件" onChange={e => {
        if (e.currentTarget.files) addFiles(e.currentTarget.files)
        e.currentTarget.value = ''
      }}/>
      <form className="composer" data-dragging={draggingFiles} onSubmit={e=>{e.preventDefault();void submit()}}>
        {!!files.length && <div className="attachment-list">
          {files.map(({ id, file }) => <div className="attachment-chip" key={id}>
            <span className="attachment-label" title={file.name}>
              <span>{file.name}</span><small className="small">{attachmentSize(file.size)}</small>
            </span>
            <button type="button" className="remove-attachment" aria-label={'移除 ' + file.name} onClick={() => {
              setDraft({ files: files.filter(item => item.id !== id) })
              setAttachmentError('')
            }}>×</button>
          </div>)}
        </div>}
        <div className="composer-row">
        <button type="button" aria-label="快捷输入" aria-expanded={tools} onClick={() => { setTools(!tools); setMention(null) }}>＋</button>
        <textarea ref={messageInput} rows={1} value={input} maxLength={8000} aria-label="消息" placeholder={'给'+currentName+'发消息'}
          aria-controls={candidates.length ? mentionId : undefined}
          onClick={() => setMention(null)}
          onChange={e => changeInput(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (candidates.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const delta = e.key === 'ArrowDown' ? 1 : -1
              setMentionIndex(index => (index + delta + candidates.length) % candidates.length)
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const candidate = candidates[mentionIndex] ?? candidates[0]
              if (candidate) insertMention(candidate)
              else void submit()
            } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) setMention(null)
          }}/>
        <button className="send" disabled={!canSend} aria-label="发送">↑</button>
        </div>
      </form>
      {!!candidates.length && <div className="mention-list" id={mentionId} role="group" aria-label="提及伙伴">
        {candidates.map((p, index) => <button type="button" key={p.id} aria-label={'@' + p.name} ref={index === mentionIndex ? selectedMention : undefined}
          data-highlighted={index === mentionIndex} onMouseDown={e => e.preventDefault()} onClick={() => insertMention(p)}>
          <Avatar partner={p}/><span>{p.name}</span>
        </button>)}
      </div>}
    </div>}
  </main>
  {creating && <CreationDialog partners={partners} initialMode={creating} onClose={() => setCreating(null)} onCreate={snapshot => {
    setCreating(null)
    select(snapshot.room, snapshot)
  }}/>}
  {settings && <SettingsDialog settings={settings} partners={partners} onClose={() => setSettings(null)} onChange={snapshot => {
    setSettings(null)
    select(snapshot.room, snapshot)
  }}/>}
  {recentlyDeleted && <RecentlyDeleted removed={view?.deleted ?? []} onClose={() => setRecentlyDeleted(false)} onRestore={snapshot => {
    setRecentlyDeleted(false)
    select(snapshot.room, snapshot)
  }}/>}
  </div>
}
