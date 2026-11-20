import type { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { partners, team, type AssistantView, type Card, type Group, type Identity, type Partner, type Workspace } from './contracts.ts'
import { fileContext, fileSignature, fileView, readDownload, storeFiles, uploadFiles, type StoredFile } from './files.ts'
import { GroupWorkQueue, validateWork, type WorkInput, type WorkStep } from './group-work.ts'
import { planSchema, type Action, type Planner } from './planner.ts'

const roomId = z.string().min(1).max(64)
const textInput = z.string().trim().min(1).max(8000)
const partnerName = z.string().trim().min(1).max(16)
  .refine(name => !/[@＠\r\n\t]/.test(name), '伙伴名字不能包含 @ 或换行')
  .transform(name => name.normalize('NFC'))
const partnerProfile = { name: partnerName, role: z.string().trim().min(1).max(80) }
const groupName = z.string().trim().min(1).max(32)
const memberIds = z.array(roomId).refine(ids => new Set(ids).size === ids.length, '请勿重复选择伙伴')
const roomLifecycle = { id: roomId, room: roomId.optional() }
const nameKey = (name: string) => name.normalize('NFC').toLowerCase()
export const command = z.discriminatedUnion('op', [
  z.object({ op: z.literal('message'), room: roomId, id: z.uuid(), text: z.string().trim().max(8000),
    mention: roomId.optional(), files: uploadFiles.default([]) }),
  z.object({ op: z.literal('create-partner'), id: z.uuid().optional(), ...partnerProfile }),
  z.object({ op: z.literal('create-group'), id: z.uuid().optional(), name: groupName,
    members: memberIds.refine(ids => ids.length >= 2, '请选择至少两位伙伴') }),
  z.object({ op: z.literal('update-partner'), id: roomId, ...partnerProfile }),
  z.object({ op: z.literal('update-group'), id: roomId, name: groupName, members: memberIds }),
  z.object({ op: z.literal('delete-partner'), ...roomLifecycle }),
  z.object({ op: z.literal('delete-group'), ...roomLifecycle }),
  z.object({ op: z.literal('restore-room'), ...roomLifecycle }),
  z.object({ op: z.literal('retry'), room: roomId, id: z.string() }),
  z.object({ op: z.literal('retry-work'), room: roomId, id: z.uuid() }),
  z.object({ op: z.literal('card'), room: roomId, id: z.string(), action: z.enum(['confirm','edit','cancel','stop']), previous: z.string().max(8000), body: textInput.optional() }),
  z.object({ op: z.literal('login') }),
  z.object({ op: z.literal('connection') }),
])
type Command = z.infer<typeof command>
interface Meta { parent?: string; mention?: string | null; receipt?: string; action?: Action; profile?: string; group?: Identity; person?: Identity; since?: string; until?: string; token?: string; files?: StoredFile[]; uploadSignature?: string }
interface Row extends Card { meta: string }
interface GroupRow extends Omit<Group, 'members'> { members: string }
interface Roster {
  partners: Partner[]
  groups: Group[]
  removedPartners: Partner[]
  deleted: NonNullable<AssistantView['deleted']>
  memberLinks: Map<string, string[]>
}

/** Invalid assistant input that the panel can present to the user. */
export class AssistantInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message) }
}

function mentionedPartner(text: string, roster: Partner[]) {
  const request = text.normalize('NFC')
  const names = [...roster].sort((a, b) => b.name.length - a.name.length)
  for (const match of request.matchAll(/[@＠]/g)) {
    const tail = request.slice(match.index + 1)
    const partner = names.find(p => tail.startsWith(p.name)
      && !(/[a-z\d]$/i.test(p.name) && /^[a-z\d_]/i.test(tail.slice(p.name.length))))
    if (partner) return partner.id
  }
}
const iso = () => new Date().toISOString()
const display = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '').slice(0, 32000)
const problem = (e: unknown) => e instanceof Error ? e.message : '操作未完成。'
const labels = { agenda: '查日程', document: '读文档', invite: '发会邀', draft: '群消息草稿', watch: '留意同事回复' }
const fullDate = (value: string) => new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
function agendaText(value: unknown) {
  const data = value as { events?: { title?: string; summary?: string; start?: unknown; end?: unknown; startTime?: unknown; endTime?: unknown }[]; hasMore?: boolean }
  if (value && typeof value === 'object' && 'busy' in value && Array.isArray(value.busy)) {
    return value.busy.length ? value.busy.map(slot => '忙碌 · '+fullDate(slot.start)+' – '+fullDate(slot.end)).join('\n') : '所查同事在这个时段都有空。'
  }
  if (!Array.isArray(data?.events)) return display(value)
  if (!data.events.length) return '这个时段没有日程。'
  const when = (v: unknown) => {
    if (typeof v === 'number') return new Date(v).toLocaleString('zh-CN')
    const raw = typeof v === 'string' ? v : (v as { dateTime?: string; date?: string })?.dateTime ?? (v as { date?: string })?.date
    return raw && Number.isFinite(Date.parse(raw)) ? fullDate(raw) : ''
  }
  return data.events.map(e => [e.summary || e.title || '日程', [when(e.start ?? e.startTime), when(e.end ?? e.endTime)].filter(Boolean).join(' – ')].filter(Boolean).join('\n')).join('\n\n')
    + (data.hasMore ? '\n还有更多日程，请缩短查询时段。' : '')
}

/** Durable personal conversations and account-bound DingTalk actions in the Superagent store. */
export class AssistantDesk {
  private readonly groupWork: GroupWorkQueue
  private readonly work = new Set<Promise<unknown>>()
  private readonly busy = new Set<string>()
  private readonly admitting = new Set<string>()
  private readonly pendingUploads = new Set<string>()
  private readonly confirming = new Map<string, Row>()
  private polling = false
  private closing = false
  constructor(private db: DatabaseSync, private provider: () => Workspace | undefined, private plan: Planner,
    private attachmentStore: () => Pick<AttachmentStore, 'saveFile' | 'readFileStream'> | undefined = () => undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_card (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS assistant_room ON assistant_card(room);
      CREATE INDEX IF NOT EXISTS assistant_state ON assistant_card(state);
      CREATE TABLE IF NOT EXISTS assistant_partner (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_group (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_room_lifecycle (
        id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
      UPDATE assistant_card SET state='unknown',title='结果待核对' WHERE state='sending';
      UPDATE assistant_card SET state='retry' WHERE state IN ('planning','working','pending');`)
    this.groupWork = new GroupWorkQueue(db, (room, requestId, step, inputs) => this.runWorkStep(room, requestId, step, inputs))
  }
  private rows(sql: string, ...params: string[]) { return this.db.prepare(sql).all(...params) as unknown as Row[] }
  private row(room: string, id: string) {
    const row = this.rows('SELECT * FROM assistant_card WHERE room=? AND id=?', room, id)[0]
    if (!row) throw new Error('找不到这条消息。')
    return row
  }
  private add(id: string, room: string, author: string, kind: string, state: string, title: string, body: string, meta: Meta = {}) {
    this.db.prepare('INSERT INTO assistant_card(id,room,author,kind,state,title,body,meta) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, room, author, kind, state, title, body, JSON.stringify(meta))
  }
  private update(id: string, state: string, title: string, body: string) {
    this.db.prepare('UPDATE assistant_card SET state=?, title=?, body=? WHERE id=?').run(state,title,body,id)
  }
  private bind(id: string, account: Identity, target: string, meta: Meta) {
    this.db.prepare('UPDATE assistant_card SET account=?, target=?, meta=? WHERE id=?').run(account.name,target,JSON.stringify({ ...meta, profile: account.id }),id)
  }
  private roster(): Roster {
    const profiles = this.db.prepare("SELECT id, name, role, 'sun' AS color FROM assistant_partner ORDER BY rowid").all() as unknown as Partner[]
    const profilesById = new Map(profiles.map(profile => [profile.id, profile]))
    const allPartners = partners.map(partner => ({ ...(profilesById.get(partner.id) ?? partner), color: partner.color }))
    const presetIds = new Set(partners.map(partner => partner.id))
    allPartners.push(...profiles.filter(profile => !presetIds.has(profile.id)))

    const groupRows = this.db.prepare('SELECT id, name, members FROM assistant_group ORDER BY rowid').all() as unknown as GroupRow[]
    const allGroups = new Map<string, Group>([[team.id, team]])
    for (const group of groupRows) allGroups.set(group.id, { ...group, members: JSON.parse(group.members) as string[] })

    const hidden = this.db.prepare('SELECT id FROM assistant_room_lifecycle ORDER BY deleted_at DESC,rowid DESC').all() as { id: string }[]
    const hiddenIds = new Set(hidden.map(row => row.id))
    const removedPartners = allPartners.filter(partner => hiddenIds.has(partner.id))
    const deleted: Roster['deleted'] = []
    for (const row of hidden) {
      const removed = removedPartners.find(partner => partner.id === row.id)
      const group = allGroups.get(row.id)
      if (removed) deleted.push({ id: row.id, kind: 'partner', name: removed.name })
      else if (group) deleted.push({ id: row.id, kind: 'group', name: group.name })
    }
    return {
      partners: allPartners.filter(partner => !hiddenIds.has(partner.id)),
      groups: [...allGroups.values()].filter(group => !hiddenIds.has(group.id))
        .map(group => ({ ...group, members: group.members.filter(id => !hiddenIds.has(id)) })),
      removedPartners,
      deleted,
      memberLinks: new Map([...allGroups.values()].map(group => [group.id, group.members])),
    }
  }
  private room(roomId: string, roster: Roster) {
    const group = roster.groups.find(g => g.id === roomId)
    if (group) {
      const members = new Set(group.members)
      return { name: group.name, partners: roster.partners.filter(p => members.has(p.id)), target: undefined }
    }
    const partner = roster.partners.find(p => p.id === roomId)
    if (partner) return { name: partner.name, partners: [partner], target: partner.id }
    throw new AssistantInputError('找不到这个会话', 404)
  }
  private createPartner(cmd: Extract<Command, { op: 'create-partner' }>) {
    const id = 'partner-' + (cmd.id ?? randomUUID())
    const existing = this.db.prepare('SELECT name, role FROM assistant_partner WHERE id=?').get(id)
    if (existing) {
      if (existing.name !== cmd.name || existing.role !== cmd.role) throw new AssistantInputError('伙伴资料已变化，请重新创建')
      return this.conversation(id)
    }
    const key = nameKey(cmd.name)
    this.assertAvailableName(cmd.name, id, this.roster())
    const inserted = this.db.prepare('INSERT INTO assistant_partner(id,name,name_key,role) VALUES(?,?,?,?) ON CONFLICT(name_key) DO NOTHING')
      .run(id, cmd.name, key, cmd.role)
    if (!inserted.changes) throw new AssistantInputError('这个名字已被使用，请换一个')
    return this.conversation(id)
  }
  private createGroup(cmd: Extract<Command, { op: 'create-group' }>) {
    const id = 'group-' + (cmd.id ?? randomUUID())
    const existing = this.db.prepare('SELECT name, members FROM assistant_group WHERE id=?').get(id)
    if (existing) {
      const saved = JSON.parse(existing.members as string) as string[]
      if (existing.name !== cmd.name || saved.length !== cmd.members.length || !saved.every(member => cmd.members.includes(member))) {
        throw new AssistantInputError('群聊资料已变化，请重新创建')
      }
    } else {
      const members = this.currentMembers(cmd.members, this.roster())
      this.db.prepare('INSERT INTO assistant_group(id,name,members) VALUES(?,?,?)').run(id, cmd.name, JSON.stringify(members))
    }
    return this.conversation(id)
  }
  private currentMembers(ids: string[], roster: Roster) {
    const requested = new Set(ids)
    const members = roster.partners.filter(partner => requested.has(partner.id)).map(partner => partner.id)
    if (members.length !== requested.size) throw new AssistantInputError('有伙伴已不可用，请重新选择群成员')
    return members
  }
  private assertAvailableName(name: string, id: string, roster: Roster) {
    const key = nameKey(name)
    if ([...roster.partners, ...roster.removedPartners].some(partner => partner.id !== id && nameKey(partner.name) === key)) {
      throw new AssistantInputError('这个名字已被使用，请换一个')
    }
  }
  private updatePartner(cmd: Extract<Command, { op: 'update-partner' }>) {
    const roster = this.roster()
    if (!roster.partners.some(partner => partner.id === cmd.id)) throw new AssistantInputError('找不到这个伙伴', 404)
    this.assertAvailableName(cmd.name, cmd.id, roster)
    this.db.prepare(`INSERT INTO assistant_partner(id,name,name_key,role) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,role=excluded.role`)
      .run(cmd.id, cmd.name, nameKey(cmd.name), cmd.role)
    return this.conversation(cmd.id)
  }
  private updateGroup(cmd: Extract<Command, { op: 'update-group' }>) {
    const roster = this.roster()
    const group = roster.groups.find(group => group.id === cmd.id)
    if (!group) throw new AssistantInputError('找不到这个群聊', 404)
    const members = this.currentMembers(cmd.members, roster)
    const removed = group.members.filter(member => !members.includes(member))
    const changed = members.length !== group.members.length || removed.length > 0
    if (changed && members.length < 2) throw new AssistantInputError('请选择至少两位伙伴')
    if (removed.length) this.assertIdle(group.id, removed)

    const archived = new Set(roster.removedPartners.map(partner => partner.id))
    const links = roster.memberLinks.get(cmd.id) ?? []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO assistant_group(id,name,members) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,members=excluded.members`)
        .run(cmd.id, cmd.name, JSON.stringify([...members, ...links.filter(id => archived.has(id))]))
      if (removed.length) this.stopWatches(group.id, removed)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.conversation(cmd.id)
  }
  private assertIdle(room: string, authors?: string[]) {
    const scope = authors ? JSON.stringify(authors) : null
    const runningActions = this.db.prepare(`SELECT 1 FROM assistant_card WHERE room=? AND state IN ('pending','working','sending')
      AND (? IS NULL OR author IN (SELECT value FROM json_each(?))) LIMIT 1`).get(room, scope, scope)
    if (this.busy.has(room) || this.admitting.has(room) || runningActions || this.groupWork.hasActive(room, authors)
        || [...this.confirming.values()].some(card => card.room === room && (!authors || authors.includes(card.author)))) {
      throw new AssistantInputError('这里还有任务或钉钉操作正在执行，请等它完成后再试')
    }
  }
  private stopWatches(room: string, authors?: string[]) {
    const scope = authors ? JSON.stringify(authors) : null
    this.db.prepare(`UPDATE assistant_card SET state='stopped',title='已停止关注',body=''
      WHERE room=? AND state='watching' AND (? IS NULL OR author IN (SELECT value FROM json_each(?)))`).run(room, scope, scope)
  }
  private deleteRoom(cmd: Extract<Command, { op: 'delete-partner' | 'delete-group' }>) {
    const roster = this.roster()
    const partner = cmd.op === 'delete-partner'
    const kind = partner ? 'partner' : 'group'
    if (roster.deleted.some(room => room.kind === kind && room.id === cmd.id)) return this.roomAfterChange(cmd.room)
    const items = partner ? roster.partners : roster.groups
    if (!items.some(item => item.id === cmd.id)) throw new AssistantInputError('找不到这个会话', 404)
    const groups = partner ? roster.groups.filter(group => group.members.includes(cmd.id)) : []
    this.assertIdle(cmd.id)
    for (const group of groups) this.assertIdle(group.id, [cmd.id])
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO assistant_room_lifecycle(id,deleted_at) VALUES(?,?)').run(cmd.id, iso())
      this.stopWatches(cmd.id)
      for (const group of groups) this.stopWatches(group.id, [cmd.id])
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.roomAfterChange(cmd.room)
  }
  private restoreRoom(cmd: Extract<Command, { op: 'restore-room' }>) {
    const roster = this.roster()
    if (!roster.deleted.some(room => room.id === cmd.id) && !this.hasRoom(cmd.id, roster)) {
      throw new AssistantInputError('找不到这个会话', 404)
    }
    this.db.prepare('DELETE FROM assistant_room_lifecycle WHERE id=?').run(cmd.id)
    return this.roomAfterChange(cmd.room)
  }
  private hasRoom(room: string, roster: Roster) {
    return roster.groups.some(group => group.id === room) || roster.partners.some(partner => partner.id === room)
  }
  private roomAfterChange(preferred?: string): AssistantView {
    const roster = this.roster()
    const room = preferred && this.hasRoom(preferred, roster) ? preferred
      : roster.groups.find(group => group.members.length > 0)?.id ?? roster.partners[0]?.id ?? 'home'
    return this.snapshot(room, roster)
  }
  view(room: string): Card[] {
    return this.conversation(room).cards
  }
  private cards(room: string): Card[] {
    return this.rows('SELECT id,room,author,kind,title,body,state,account,target,meta FROM (SELECT rowid AS seq,* FROM assistant_card WHERE room=? ORDER BY rowid DESC LIMIT 300) ORDER BY seq', room)
      .map(({ meta, ...card }) => {
        const files = (JSON.parse(meta) as Meta).files
        return files?.length ? { ...card, files: files.map(fileView) } : card
      })
  }
  async download(room: string, id: string) {
    this.assertRoom(room)
    const match = this.db.prepare(`SELECT file.value AS stored FROM assistant_card AS card,
      json_each(card.meta, '$.files') AS file WHERE card.room=? AND json_extract(file.value, '$.id')=?`).get(room, id)
    if (!match) throw new AssistantInputError('找不到这个附件', 404)
    return this.tracked(() => readDownload(this.attachmentStore(), JSON.parse(String(match.stored)) as StoredFile))
  }
  conversation(room: string): AssistantView {
    if (room === 'home') return this.roomAfterChange()
    const roster = this.roster()
    this.room(room, roster)
    return this.snapshot(room, roster)
  }
  assertRoom(room: string): void {
    this.room(room, this.roster())
  }
  private snapshot(room: string, { partners, groups, deleted, removedPartners }: Roster): AssistantView {
    const empty = room === 'home'
    return { room, partners, groups, deleted, removedPartners, fileUploads: !!this.attachmentStore(),
      cards: empty ? [] : this.cards(room), work: empty ? [] : this.groupWork.list(room) }
  }
  private tracked<T>(job: () => Promise<T>) {
    if (this.closing) throw new Error('助手正在关闭。')
    const p = job(); this.work.add(p)
    void p.finally(() => this.work.delete(p)).catch(() => {})
    return p
  }
  resumeGroupWork() { this.groupWork.resume() }
  async stop() {
    this.closing = true
    await Promise.allSettled([this.groupWork.stop(), ...this.work])
  }
  private workspace() {
    const service = this.provider()
    if (!service) throw new Error('请在当前 DSH profile 安装并启用 dsh-dingtalk。')
    return service
  }
  execute(input: unknown) {
    const cmd = command.parse(input)
    return this.tracked(async () => {
      if (cmd.op === 'connection') return { installed: !!this.provider(), account: await this.provider()?.account() ?? null }
      if (cmd.op === 'login') { await this.workspace().login(); return { account: await this.workspace().account() } }
      if (cmd.op === 'create-partner') return this.createPartner(cmd)
      if (cmd.op === 'create-group') return this.createGroup(cmd)
      if (cmd.op === 'update-partner') return this.updatePartner(cmd)
      if (cmd.op === 'update-group') return this.updateGroup(cmd)
      if (cmd.op === 'delete-partner' || cmd.op === 'delete-group') return this.deleteRoom(cmd)
      if (cmd.op === 'restore-room') return this.restoreRoom(cmd)
      const roster = this.roster()
      const conversation = this.room(cmd.room, roster)
      if (cmd.op === 'card') await this.card(cmd, conversation.partners)
      else if (cmd.op === 'retry-work') {
        const task = this.groupWork.list(cmd.room).find(item => item.id === cmd.id)
        if (task?.steps.some(step => step.state !== 'done' && !conversation.partners.some(p => p.id === step.partner))) {
          throw new AssistantInputError('任务需要的伙伴已不在群里，重新加入后可重试')
        }
        if (!this.groupWork.retry(cmd.room, cmd.id)) throw new AssistantInputError('找不到可重试的任务')
      } else if (cmd.op === 'retry') {
        const row = this.row(cmd.room,cmd.id)
        if (!['retry','connect'].includes(row.state)) return this.conversation(cmd.room)
        if (row.kind === 'user') {
          this.assertHasMember(conversation.partners)
          await this.message(row)
        }
        else if (row.state === 'connect') {
          this.assertActiveAuthor(row, conversation.partners)
          const { parent }: Meta = JSON.parse(row.meta)
          const pending = this.rows("SELECT * FROM assistant_card WHERE room=? AND state='connect' AND json_extract(meta,'$.parent')=? ORDER BY rowid",row.room,parent ?? '')
          const eligible = (pending.length ? pending : [row]).filter(item => conversation.partners.some(p => p.id === item.author))
          for (const item of eligible) await this.perform(item)
        } else {
          this.assertActiveAuthor(row, conversation.partners)
          await this.perform(row)
        }
      } else {
        this.assertHasMember(conversation.partners)
        if (!cmd.text && !cmd.files.length) throw new AssistantInputError('请填写消息或选择附件')
        const uploadSignature = fileSignature(cmd.files)
        const existing = this.rows('SELECT * FROM assistant_card WHERE id=?',cmd.id)[0]
        if (existing) {
          const prior: Meta = JSON.parse(existing.meta)
          if (existing.room !== cmd.room || existing.body !== cmd.text || (cmd.mention && prior.mention !== cmd.mention)
            || prior.uploadSignature !== uploadSignature) {
            throw new AssistantInputError('消息标识冲突，请重新发送')
          }
          return this.conversation(cmd.room)
        }
        const mention = cmd.mention ?? (conversation.target ? undefined : mentionedPartner(cmd.text, [...roster.partners, ...roster.removedPartners]))
        if (mention && !conversation.partners.some(p => p.id === mention)) throw new AssistantInputError('只能提及当前会话中的伙伴')
        if (this.busy.has(cmd.room) || this.admitting.has(cmd.room) || this.pendingUploads.has(cmd.id)) {
          throw new AssistantInputError('上一条消息正在处理，请稍后再发')
        }
        let files: StoredFile[] | undefined
        if (cmd.files.length) {
          this.admitting.add(cmd.room)
          this.pendingUploads.add(cmd.id)
          try { files = await storeFiles(this.attachmentStore(), cmd.files) }
          catch (error) { throw new AssistantInputError(problem(error)) }
          finally {
            this.admitting.delete(cmd.room)
            this.pendingUploads.delete(cmd.id)
          }
        }
        this.add(cmd.id,cmd.room,'me','user','planning','',cmd.text,{ mention: mention ?? null, files, uploadSignature })
        await this.message(this.row(cmd.room,cmd.id))
      }
      return this.conversation(cmd.room)
    })
  }
  private assertHasMember(members: Partner[]): void {
    if (!members.length) throw new AssistantInputError('群里暂时没有伙伴，请添加成员后再发消息')
  }
  private assertActiveAuthor(row: Row, members: Partner[]): void {
    if (!members.some(partner => partner.id === row.author)) throw new AssistantInputError('处理这项工作的伙伴已不在当前会话')
  }
  private async message(row: Row) {
    if (this.busy.has(row.room)) return
    this.busy.add(row.room)
    this.update(row.id,'planning','',row.body)
    try {
      const roster = this.roster()
      const conversation = this.room(row.room, roster)
      const meta: Meta = JSON.parse(row.meta)
      const mention = meta.mention === undefined ? mentionedPartner(row.body, roster.partners) : meta.mention
      const target = conversation.target ?? mention ?? undefined
      if (target && !conversation.partners.some(p => p.id === target)) throw new Error('只能提及当前会话中的伙伴。')
      const plan = planSchema.parse(await this.plan(row.room, this.history(row), row.body, { ...conversation, target, files: meta.files?.map(fileContext) }))
      const bot = target ?? plan.bot
      if (!conversation.partners.some(p => p.id === bot)) throw new Error('助手未能从当前群成员中选择答复者，请重试。')
      if (plan.work) {
        if (conversation.target || plan.actions.length) throw new Error('这次分工需要在群聊中单独安排，请重试。')
        validateWork(plan.work, conversation.partners.map(p => p.id))
        if (target && !plan.work.steps.some(step => step.bot === target && !step.dependsOn.length)) {
          throw new Error('被提及的伙伴需要先接手一项工作，请重试。')
        }
      }
      for (const a of plan.actions) {
        if (a.kind === 'invite' && (!row.body.includes(a.mandate) || !/(邀|约|安排.{0,12}会|组织.{0,12}会|schedule|invite|book)/i.test(a.mandate)
          || /(?:不要|先不|暂不|别|取消|do not|don't).{0,12}(?:发|邀|约|安排|schedule|invite)/i.test(row.body))) {
          throw new Error('请明确说明要发会邀，以及希望邀请的同事和时间。')
        }
      }
      const ids: string[] = []
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.update(row.id,'done','',row.body)
        if (plan.work) this.groupWork.create(row.room, row.id, plan.work)
        else if (plan.reply || !plan.actions.length) this.add(randomUUID(),row.room,bot,'text','done','',plan.reply || '你想先处理哪件事？')
        for (const a of plan.actions) {
          const id = randomUUID(); ids.push(id)
          this.add(id,row.room,bot,a.kind,'pending',labels[a.kind],'',{ parent:row.id, action:a })
        }
        this.db.exec('COMMIT')
      } catch (e) { this.db.exec('ROLLBACK'); throw e }
      if (plan.work) this.groupWork.resume()
      for (const id of ids) await this.perform(this.row(row.room,id))
    } catch (e) { this.update(row.id,'retry',problem(e),row.body) }
    finally { this.busy.delete(row.room) }
  }
  private history(row: Row) {
    const previous = this.db.prepare(`WITH recent_cards AS (
      SELECT id, room, rowid AS seq, author, title, body FROM assistant_card
      WHERE room=? AND kind<>'incoming' AND rowid<(SELECT rowid FROM assistant_card WHERE id=?)
      ORDER BY rowid DESC LIMIT 16
    ), history_entries AS (
      SELECT seq, 0 AS step_seq, author, title, body FROM recent_cards
      UNION ALL
      SELECT card.seq, step.rowid, step.partner, '已完成分工《' || work.title || '》 · ' || step.title, step.output
      FROM recent_cards AS card
      JOIN assistant_group_work AS work ON work.id=card.id AND work.room=card.room
      JOIN assistant_group_work_step AS step ON step.work_id=work.id
      WHERE NOT EXISTS (SELECT 1 FROM assistant_group_work_step AS incomplete
        WHERE incomplete.work_id=work.id AND incomplete.state<>'done')
    )
    SELECT author, title, substr(body, 1, 1400) AS excerpt FROM history_entries
    ORDER BY seq DESC, step_seq DESC LIMIT 16`).all(row.room, row.id)
    return JSON.stringify(previous.reverse().map(card => [card.author, card.title, card.excerpt]))
  }
  private async runWorkStep(room: string, requestId: string, step: WorkStep, inputs: WorkInput[]) {
    const row = this.row(room, requestId)
    const conversation = this.room(room, this.roster())
    if (!conversation.partners.some(partner => partner.id === step.bot)) throw new Error('该伙伴已无法参与当前群聊')
    const result = planSchema.parse(await this.plan(room, this.history(row), row.body, {
      ...conversation,
      target: step.bot,
      files: (JSON.parse(row.meta) as Meta).files?.map(fileContext),
      workStep: { title: step.title, instructions: step.instructions, inputs },
    }))
    if (result.bot !== step.bot || result.actions.length || result.work || !result.reply.trim()) {
      throw new Error('该步骤未返回可交接的成果，请重试')
    }
    return result.reply.trim()
  }
  private async perform(row: Row) {
    this.assertActiveAuthor(row, this.room(row.room, this.roster()).partners)
    const start = this.db.prepare("UPDATE assistant_card SET state='working' WHERE id=? AND state IN ('pending','connect','retry')").run(row.id)
    if (!start.changes) return
    const meta: Meta = JSON.parse(row.meta), a = meta.action!
    let sending = false
    try {
      const service = this.workspace(), acct = await service.account()
      if (!acct) { this.update(row.id,'connect',labels[a.kind],'登录钉钉后可以继续这件事。'); return }
      if (meta.profile && meta.profile !== acct.id) throw new Error('请切回原钉钉账号。')
      this.bind(row.id,acct,'',meta)
      if (a.kind === 'document') {
        const doc = await service.document(acct.id,a.query)
        this.update(row.id,'done',doc.title,display(doc.content))
      } else if (a.kind === 'agenda' || a.kind === 'invite') {
        const people = await Promise.all(a.people.map(p => service.person(acct.id,p)))
        const ids = [...new Set(people.map(p => p.id))]
        this.bind(row.id,acct,people.map(p => p.name).join('、'),meta)
        if (a.kind === 'agenda') {
          const data = ids.length ? await service.busy(acct.id,ids,a.start,a.end) : await service.agenda(acct.id,a.start,a.end)
          this.update(row.id,'done',ids.length ? '同事闲忙' : '我的日程',agendaText(data))
        } else {
          const detail = a.title+'\n'+fullDate(a.start)+' – '+fullDate(a.end)
          this.update(row.id,'sending','正在创建会邀',detail); sending = true
          const receipt = await service.invite(acct.id,a.title,a.start,a.end,ids)
          this.bind(row.id,acct,people.map(p => p.name).join('、'),{...meta,receipt})
          this.update(row.id,'done','会邀已发',detail)
        }
      } else {
        const group = await service.group(acct.id,a.group)
        if (a.kind === 'draft') {
          this.bind(row.id,acct,group.name,{...meta,group})
          this.update(row.id,'draft','确认发送群消息',a.body)
        } else {
          const person = await service.person(acct.id,a.person)
          this.bind(row.id,acct,group.name,{...meta,person,group,since:iso()})
          this.update(row.id,'watching','正在留意'+person.name+'的回复','新消息会出现在这个会话。')
        }
      }
    } catch (e) { this.update(row.id,sending ? 'unknown' : 'retry',sending ? '请在钉钉核对会邀结果' : labels[a.kind],problem(e)) }
  }
  private async card(cmd: Extract<Command,{op:'card'}>, members: Partner[]) {
    const row = this.row(cmd.room,cmd.id)
    if (cmd.action === 'stop') {
      this.db.prepare("UPDATE assistant_card SET state='stopped', title='已停止关注' WHERE id=? AND state='watching'").run(row.id); return
    }
    if (row.state !== 'draft' || row.body !== cmd.previous) throw new Error('草稿已变化，请核对最新版本。')
    if (cmd.action === 'cancel') { this.update(row.id,'canceled','已取消发送',row.body); return }
    this.assertActiveAuthor(row, members)
    if (cmd.action === 'edit') { this.update(row.id,'draft',row.title,textInput.parse(cmd.body)); return }
    if (this.confirming.has(row.id)) throw new Error('草稿正在处理。')
    this.confirming.set(row.id, row)
    try {
      const meta: Meta = JSON.parse(row.meta), service = this.workspace(), acct = await service.account()
      if (!acct || acct.id !== meta.profile) throw new Error('请先连接草稿所属的钉钉账号。')
      const changed = this.db.prepare("UPDATE assistant_card SET state='sending' WHERE id=? AND state='draft' AND body=?").run(row.id,cmd.previous)
      if (!changed.changes) throw new Error('草稿已处理或修改。')
      try {
        const receipt = await service.send(acct.id,meta.group!.id,row.body,row.id)
        this.bind(row.id,acct,row.target,{...meta,receipt})
        this.update(row.id,'done','群消息已发送',row.body)
      } catch { this.update(row.id,'unknown','发送结果待核对',row.body) }
    } finally { this.confirming.delete(row.id) }
  }
  async tick() {
    if (this.polling || this.closing) return
    this.polling = true
    try { await this.tracked(async () => {
      const watches = this.rows("SELECT * FROM assistant_card WHERE state='watching'")
      if (!watches.length) return
      let service: Workspace, acct: Identity | null
      try { service = this.workspace(); acct = await service.account() }
      catch (e) {
        this.db.prepare("UPDATE assistant_card SET body=? WHERE state='watching'").run(problem(e))
        return
      }
      for (const row of watches) {
        if (this.row(row.room,row.id).state !== 'watching') continue
        const meta: Meta = JSON.parse(row.meta)
        try {
          if (!acct || acct.id !== meta.profile) throw new Error('等待原钉钉账号重新连接。')
          const until = meta.until || new Date(Math.min(Date.now(),Date.parse(meta.since!) + 86_400_000)).toISOString()
          if (until <= meta.since!) continue
          const page = await service.replies(acct.id,meta.group!.id,meta.person!.id,meta.since!,until,meta.token || '')
          if (this.row(row.room,row.id).state !== 'watching') continue
          this.db.exec('BEGIN IMMEDIATE')
          try {
            for (const m of page.messages) {
              const id = createHash('sha256').update(JSON.stringify([row.room,acct.id,meta.group!.id,m.id])).digest('hex')
              if (!this.rows('SELECT id FROM assistant_card WHERE id=?',id).length) {
                this.add(id,row.room,meta.person!.name,'incoming','done','钉钉同事 · '+meta.group!.name,m.text)
              }
            }
            this.bind(row.id,acct,row.target,{...meta,since:page.next ? meta.since! : until,until:page.next ? until : '',token:page.next})
            this.db.prepare("UPDATE assistant_card SET body='新消息会出现在这个会话。' WHERE id=?").run(row.id)
            this.db.exec('COMMIT')
          } catch (e) { this.db.exec('ROLLBACK'); throw e }
        } catch (e) { this.db.prepare("UPDATE assistant_card SET body=? WHERE id=? AND state='watching'").run(problem(e),row.id) }
      }
    }) } finally { this.polling = false }
  }
}
