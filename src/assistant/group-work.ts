import type { DatabaseSync } from 'node:sqlite'
import type { GroupWork, GroupWorkStep } from './contracts.ts'

export interface WorkStep {
  id: string
  bot: string
  title: string
  instructions: string
  dependsOn: string[]
}

export interface WorkInput {
  title: string
  partner: string
  output: string
}

export interface WorkPlan {
  title: string
  steps: WorkStep[]
}

interface WorkRow {
  id: string
  room: string
  title: string
}

interface StepRow {
  work_id: string
  id: string
  partner: string
  title: string
  instructions: string
  depends_on: string
  state: GroupWorkStep['state']
  output: string
}

type RunStep = (room: string, requestId: string, step: WorkStep, inputs: WorkInput[]) => Promise<string>
const parallelSteps = 2
const dependenciesDone = `NOT EXISTS (
  SELECT 1 FROM json_each(step.depends_on) AS dependency
  LEFT JOIN assistant_group_work_step AS source ON source.work_id=step.work_id AND source.id=dependency.value
  WHERE source.state IS NOT 'done'
)`

function orderedSteps(steps: WorkStep[]): WorkStep[] {
  const remaining = new Map(steps.map(step => [step.id, step]))
  const placed = new Set<string>()
  const ordered: WorkStep[] = []
  while (remaining.size) {
    const ready = [...remaining.values()].filter(step => step.dependsOn.every(id => placed.has(id)))
    if (!ready.length) throw new Error('分工步骤互相等待，请重试')
    for (const step of ready) {
      remaining.delete(step.id)
      placed.add(step.id)
      ordered.push(step)
    }
  }
  return ordered
}

export function validateWork(plan: WorkPlan, memberIds: Iterable<string>): void {
  const members = new Set(memberIds)
  const ids = new Set(plan.steps.map(step => step.id))
  if (ids.size !== plan.steps.length) throw new Error('分工里有重复的步骤，请重试')
  if (plan.steps.some(step => !members.has(step.bot))) throw new Error('分工只能指派给当前群成员，请重试')
  if (new Set(plan.steps.map(step => step.bot)).size < 2) throw new Error('分工至少需要两位伙伴，请重试')
  if (plan.steps.some(step => new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !ids.has(id)))) {
    throw new Error('分工引用了无效的交接步骤，请重试')
  }
  orderedSteps(plan.steps)
}

function stepView(row: StepRow): GroupWorkStep {
  return { id: row.id, partner: row.partner, title: row.title, state: row.state, output: row.output,
    dependsOn: JSON.parse(row.depends_on) as string[] }
}

function workState(steps: GroupWorkStep[]): GroupWork['state'] {
  const completed = new Set(steps.filter(step => step.state === 'done').map(step => step.id))
  if (completed.size === steps.length) return 'done'
  const canAdvance = steps.some(step => step.state === 'running'
    || (step.state === 'waiting' && step.dependsOn.every(id => completed.has(id))))
  return canAdvance ? 'running' : 'failed'
}

/** Persists group work and runs eligible steps once their prerequisite outputs are available. */
export class GroupWorkQueue {
  private readonly running = new Set<Promise<void>>()
  private closing = false

  constructor(private db: DatabaseSync, private runStep: RunStep) {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_group_work (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, title TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_group_work_room ON assistant_group_work(room);
    CREATE TABLE IF NOT EXISTS assistant_group_work_step (
      work_id TEXT NOT NULL REFERENCES assistant_group_work(id),
      id TEXT NOT NULL, partner TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
      depends_on TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', output TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (work_id, id)
    );
    CREATE INDEX IF NOT EXISTS assistant_group_work_step_state ON assistant_group_work_step(state);
    UPDATE assistant_group_work_step SET state='waiting', output='' WHERE state='running';`)
  }

  /** Store the plan in the same transaction as its originating chat message. */
  create(room: string, requestId: string, plan: WorkPlan): void {
    const steps = orderedSteps(plan.steps)
    this.db.prepare('INSERT INTO assistant_group_work(id,room,title) VALUES(?,?,?)').run(requestId, room, plan.title)
    const insert = this.db.prepare(`INSERT INTO assistant_group_work_step(work_id,id,partner,title,instructions,depends_on)
      VALUES(?,?,?,?,?,?)`)
    for (const step of steps) insert.run(requestId, step.id, step.bot, step.title, step.instructions, JSON.stringify(step.dependsOn))
  }

  list(room: string): GroupWork[] {
    const rows = this.db.prepare(`SELECT id,room,title FROM assistant_group_work WHERE room=? AND (
      id IN (SELECT id FROM assistant_group_work WHERE room=? ORDER BY rowid DESC LIMIT 20)
      OR EXISTS (SELECT 1 FROM assistant_group_work_step WHERE work_id=assistant_group_work.id AND state IN ('waiting','running','failed'))
    ) ORDER BY rowid`).all(room, room) as unknown as WorkRow[]
    const steps = this.db.prepare('SELECT * FROM assistant_group_work_step WHERE work_id=? ORDER BY rowid')
    return rows.map(row => {
      const items = (steps.all(row.id) as unknown as StepRow[]).map(stepView)
      return { id: row.id, requestId: row.id, title: row.title, state: workState(items), steps: items }
    })
  }

  retry(room: string, id: string): boolean {
    if (this.closing) return false
    const result = this.db.prepare(`UPDATE assistant_group_work_step SET state='waiting',output=''
      WHERE state='failed' AND work_id=(SELECT id FROM assistant_group_work WHERE room=? AND id=?)`).run(room, id)
    if (result.changes) this.resume()
    return result.changes > 0
  }

  hasActive(room: string, partners?: string[]): boolean {
    const scope = partners ? JSON.stringify(partners) : null
    return !!this.db.prepare(`SELECT 1 FROM assistant_group_work AS work WHERE room=?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM assistant_group_work_step AS affected
        WHERE affected.work_id=work.id AND affected.state<>'done' AND affected.partner IN (SELECT value FROM json_each(?))))
      AND EXISTS (SELECT 1 FROM assistant_group_work_step AS step WHERE step.work_id=work.id
        AND (step.state='running' OR (step.state='waiting' AND ${dependenciesDone}))) LIMIT 1`).get(room, scope, scope)
  }

  resume(): void {
    const slots = parallelSteps - this.running.size
    if (this.closing || slots <= 0) return
    const next = this.db.prepare(`SELECT step.*,work.room FROM assistant_group_work_step AS step
      JOIN assistant_group_work AS work ON work.id=step.work_id
      WHERE step.state='waiting' AND ${dependenciesDone} ORDER BY work.rowid, step.rowid LIMIT ?`)
      .all(slots) as unknown as (StepRow & { room: string })[]
    const claim = this.db.prepare("UPDATE assistant_group_work_step SET state='running' WHERE work_id=? AND id=? AND state='waiting'")
    for (const step of next) {
      if (!claim.run(step.work_id, step.id).changes) continue
      const job = Promise.resolve().then(() => this.run(step))
      this.running.add(job)
      void job.finally(() => {
        this.running.delete(job)
        this.resume()
      }).catch(() => { /* A persistence error leaves the step recoverable on the next restart. */ })
    }
  }

  private async run(row: StepRow & { room: string }): Promise<void> {
    const finish = this.db.prepare(`UPDATE assistant_group_work_step SET state=?,output=?
      WHERE work_id=? AND id=? AND state='running'`)
    if (this.closing) {
      finish.run('waiting', '', row.work_id, row.id)
      return
    }
    try {
      const step: WorkStep = { id: row.id, bot: row.partner, title: row.title, instructions: row.instructions,
        dependsOn: JSON.parse(row.depends_on) as string[] }
      const get = this.db.prepare("SELECT title,partner,output FROM assistant_group_work_step WHERE work_id=? AND id=? AND state='done'")
      const inputs = step.dependsOn.map(id => {
        const input = get.get(row.work_id, id) as unknown as WorkInput | undefined
        if (!input) throw new Error('步骤的交接内容尚未就绪')
        return { ...input }
      })
      const output = (await this.runStep(row.room, row.work_id, step, inputs)).trim()
      if (!output) throw new Error('步骤没有交付内容')
      finish.run('done', output, row.work_id, row.id)
    } catch {
      finish.run(this.closing ? 'waiting' : 'failed', this.closing ? '' : '未能完成这一步，可重试', row.work_id, row.id)
    }
  }

  async stop(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.running)
  }
}
