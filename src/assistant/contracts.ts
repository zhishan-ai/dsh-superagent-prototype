export interface Partner {
  id: string
  name: string
  role: string
  color: '' | 'violet' | 'teal' | 'sun'
}
export interface Group {
  id: string
  name: string
  members: string[]
}
export interface AssistantView {
  room: string
  partners: Partner[]
  groups: Group[]
  cards: Card[]
  work?: GroupWork[]
  deleted?: { kind: 'partner' | 'group'; id: string; name: string }[]
  removedPartners?: Partner[]
  fileUploads?: boolean
}

export const assistantLimits = { fileCount: 4, fileBytes: 512 * 1024, messageFileBytes: 1024 * 1024 } as const
export interface AssistantFile {
  id: string
  name: string
  bytes: number
  readable: boolean
  truncated?: boolean
}

export interface GroupWorkStep {
  id: string
  partner: string
  title: string
  dependsOn: string[]
  state: 'waiting' | 'running' | 'done' | 'failed'
  output: string
}

export interface GroupWork {
  id: string
  requestId: string
  title: string
  state: 'running' | 'done' | 'failed'
  steps: GroupWorkStep[]
}

export const partners: readonly Partner[] = [
  { id: 'white', name: '小白', role: '日程与协作', color: '' },
  { id: 'violet', name: '栗子', role: '文档与写作', color: 'violet' },
  { id: 'teal', name: '青团', role: '消息与跟进', color: 'teal' },
]
export const team: Group = { id: 'team', name: '助手群', members: partners.map(p => p.id) }
export interface Identity { id: string; name: string }
export interface Workspace {
  account(): Promise<Identity | null>
  login(): Promise<unknown>
  person(profile: string, query: string): Promise<Identity>
  group(profile: string, query: string): Promise<Identity>
  agenda(profile: string, start: string, end: string): Promise<unknown>
  busy(profile: string, people: string[], start: string, end: string): Promise<unknown>
  document(profile: string, query: string): Promise<{ title: string; content: unknown }>
  invite(profile: string, title: string, start: string, end: string, people: string[]): Promise<string>
  send(profile: string, group: string, body: string, id: string): Promise<string>
  replies(profile: string, group: string, person: string, start: string, end: string, token: string): Promise<{ messages: {id: string; text: string}[]; next: string }>
}
export interface Card {
  id: string; room: string; author: string; kind: string; title: string; body: string; state: string; account: string; target: string
  files?: AssistantFile[]
}
