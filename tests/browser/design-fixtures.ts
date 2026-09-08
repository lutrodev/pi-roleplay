/** Extra synthetic reading fixtures, for the isolated tests/browser/server.ts only. */
import { setTimeout as pause } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { AssetRecord, StorySnapshot, RunRecord } from '../../packages/rp-core/src/types.ts'

const origin = new URL(process.argv[2] ?? '')
if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || ['3080', '3091', ''].includes(origin.port)) throw new Error('Use an independent synthetic browser fixture port.')
const login = await fetch(`${origin.origin}/api/auth/login`, { method: 'POST', headers: { origin: origin.origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'browser-test-password-2026' }) })
if (!login.ok) throw new Error('This is not the browser test fixture.')
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin.origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: origin.origin, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
const models = await call<{ models: { provider: string }[] }>('/settings/models')
if (!models.models.length || models.models.some(model => model.provider !== 'browser-fixture')) throw new Error('Refusing to seed a real model environment.')
if (process.argv[3]) {
  const storyId = process.argv[3]
  await call(`/stories/${storyId}/messages`, { requestId: randomUUID(), inputs: [{ text: '潮水又退下了一些，一条新的线索出现在岸边。', attachmentIds: [] }] })
  console.log(JSON.stringify({ appendedTo: storyId })); process.exit(0)
}
const cardData = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '守塔人 · 阅读验收', description: '本项目原创的界面验收角色。', first_mes: '<initvar>{"energy":10,"weather":"阴","location":"灯塔二层","clues":["蓝色信封","旧海图"]}</initvar>海风吹动桌上的信纸。守塔人把灯移到你面前：“有些往事，只有等潮水退去才看得见。”' } }
const upload = new FormData(); upload.append('file', new Blob([JSON.stringify(cardData)], { type: 'application/json' }), 'design-state-card.json')
const imported = await call<{ card: AssetRecord }>('/assets/import/character', upload)
const { story } = await call<{ story: StorySnapshot }>('/stories', { title: '海雾长篇 · 阅读验收', profile: { scene: { openingSource: 'card', openingIndex: 0 }, resources: { card: { id: imported.card.id }, lorebooks: [], writingStyles: [] } } })
for (let index = 1; index <= 18; index++) {
  await call(`/stories/${story.id}/messages`, { requestId: randomUUID(), inputs: [{ text: `第 ${index} 次调查：我将新线索记在海图旁，接着听她讲述灯塔的往事。`, attachmentIds: [] }] })
  const until = Date.now() + 20000
  while (true) {
    const data = await call<{ story: StorySnapshot; runs: RunRecord[] }>(`/stories/${story.id}`)
    if (!data.runs.some(run => ['queued', 'running', 'waiting_user'].includes(run.status))) {
      if (data.runs[0]?.status !== 'completed') throw new Error(`Synthetic run failed: ${data.runs[0]?.error?.message}`)
      break
    }
    if (Date.now() > until) throw new Error('Synthetic run timed out.')
    await pause(100)
  }
}
console.log(JSON.stringify({ storyId: story.id, url: `${origin.origin}/stories/${story.id}`, turns: 18, variables: true }))
