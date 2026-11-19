export const partners = [
  { id: 'white', name: '小白', role: '日程与协作', color: '' },
  { id: 'violet', name: '栗子', role: '文档与写作', color: 'violet' },
  { id: 'teal', name: '青团', role: '消息与跟进', color: 'teal' },
] as const
export const rooms = ['team', ...partners.map(p => p.id)]
export const roomName = (id: string) => partners.find(p => p.id === id)?.name ?? '助手群'
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
}
