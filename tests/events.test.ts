import Fastify from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../apps/server/src/services/auth-service.ts'
import { registerAuthentication } from '../apps/server/src/http/auth.ts'
import { registerErrors } from '../apps/server/src/http/errors.ts'
import { EventStreams } from '../apps/server/src/http/events.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { StoryDeletionService } from '../apps/server/src/services/story-deletion-service.ts'
import { SidebarService } from '../apps/server/src/services/sidebar-service.ts'
import { fixture, profile } from './helpers.ts'
import { StoryFeed } from '../apps/web/src/lib/story-feed.ts'
import { readingView, type StoryNotice } from '../packages/protocol/src/reading.ts'

const clean: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of clean.splice(0)) await close() })
const origin = 'http://rp.test', password = 'synthetic-stream-password'
async function setup() {
  const x = fixture(), auth = new AuthService(x.assets)
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } })
  const security = await registerAuthentication(app, auth, { publicOrigin: origin, sessionKey: randomBytes(32) })
  registerErrors(app)
  new EventStreams(x.stories, security.authenticated).register(app)
  const controllers: AbortController[] = []
  clean.push(async () => { controllers.forEach(controller => controller.abort()); await app.close(); x.close() })
  await auth.setPassword(password)
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]!
  const story = x.stories.create('实时故事', profile())
  async function connect(after = 0, lastEventId?: number) {
    const controller = new AbortController(); controllers.push(controller)
    const response = await fetch(`${url}/api/stories/${story.id}/events?after=${after}`, { headers: { cookie, ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }) }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader(), decoder = new TextDecoder(), pending: StoryNotice[] = []
    let buffer = ''
    async function next(): Promise<StoryNotice | null> {
      while (pending.length === 0) {
        const result = await reader.read()
        if (result.done) return null
        buffer += decoder.decode(result.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          if (!frame.split('\n').includes('event: story')) continue
          const event = JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as StoryNotice
          expect(Number(frame.split('\n').find(line => line.startsWith('id: '))!.slice(4))).toBe(event.seq)
          pending.push(event)
        }
      }
      return pending.shift()!
    }
    return { controller, next }
  }
  return { ...x, app, auth, url, cookie, story, connect }
}

describe('durable SSE replay and browser-independent execution', () => {
  it('notifies already-open readers that the story was deleted and closes the stream without an error/reconnect cycle', async () => {
    const x = await setup()
    const response = await fetch(`${x.url}/api/stories/${x.story.id}/events?after=${x.story.revision}`, { headers: { cookie: x.cookie }, signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200)
    new StoryDeletionService(x.stories, new SidebarService(x.assets, x.stories), () => false).delete(x.story.id, x.story.revision)
    const body = await response.text()
    expect(body).toContain('event: story-deleted\ndata: {}')
    expect(body).not.toContain('stream-error')
    expect((await fetch(`${x.url}/api/stories/${x.story.id}/events`, { headers: { cookie: x.cookie } })).status).toBe(404)
  })

  it('assembles multi-part prose over HTTP SSE and resumes after a snapshot without duplicated chunks', async () => {
    const x = await setup(), run = new StoryService(x.stories, x.assets, x.files).send(x.story.id, randomUUID(), [{ text: '继续写作', attachmentIds: [] }]).run
    x.stories.setRunStatus(run.id, 'running')
    const snapshot = () => ({ ...readingView(x.stories.snapshot(x.story.id)), runs: x.stories.storyRuns(x.story.id) })
    const feed = new StoryFeed(x.story.id)
    let state = feed.snapshot(snapshot())
    const first = await x.connect(state.story.revision)
    for (const text of ['雨停了。', '雨停了。\n\n她推开门。', '雨停了。\n\n她推开门。“欢迎回来。”']) {
      x.stories.saveDraft(run.id, text)
      state = feed.receive(state, (await first.next())!)!
      expect(state.runs[0]?.draft).toBe(text)
    }
    const cursor = state.story.revision
    first.controller.abort()
    x.stories.saveDraft(run.id, '改写后的正文。')
    x.stories.saveDraft(run.id, '改写后的正文。🌙灯仍亮着。')
    state = feed.snapshot(snapshot())
    const second = await x.connect(cursor)
    for (let index = 0; index < 2; index++) state = feed.receive(state, (await second.next())!)!
    expect(state.runs[0]?.draft).toBe('改写后的正文。🌙灯仍亮着。')
    x.stories.saveDraft(run.id, '改写后的正文。🌙灯仍亮着。重连后继续。')
    state = feed.receive(state, (await second.next())!)!
    expect(state.runs[0]?.draft).toBe('改写后的正文。🌙灯仍亮着。重连后继续。')
  })

  it('replays across batches and resumes from Last-Event-ID without losing new events or leaking another story', async () => {
    const x = await setup(), other = x.stories.create('其他故事', profile())
    for (let index = 0; index < 105; index++) {
      x.stories.append(x.story.id, { type: 'story.renamed', data: { title: `故事 ${index}` } })
      if (index % 20 === 0) x.stories.append(other.id, { type: 'story.renamed', data: { title: '另一个故事' } })
    }
    const first = await x.connect()
    const delivered: StoryNotice[] = []
    for (let index = 0; index < 60; index++) delivered.push((await first.next())!)
    const cursor = delivered.at(-1)!.seq
    first.controller.abort()
    const last = x.stories.append(x.story.id, { type: 'story.archived', data: { archived: true } })
    const second = await x.connect(0, cursor)
    while (delivered.at(-1)?.seq !== last.seq) delivered.push((await second.next())!)
    expect(delivered.map(event => event.seq)).toEqual(x.stories.eventLog(x.story.id).map(event => event.seq))
    expect(delivered.every(event => event.storyId === x.story.id)).toBe(true)
    const live = x.stories.append(x.story.id, { type: 'story.archived', data: { archived: false } })
    expect((await second.next())?.seq).toBe(live.seq)
  })

  it('keeps the run alive after a browser abort and replays the completed draft after reconnect', async () => {
    const x = await setup()
    const run = new StoryService(x.stories, x.assets, x.files).send(x.story.id, randomUUID(), [{ text: '继续', attachmentIds: [] }]).run
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    const faults: unknown[] = []
    const queue = new RunQueue(x.stories, async id => { x.stories.saveDraft(id, '生成中'); await waiting; x.stories.saveDraft(id, '生成中的完整草稿'); }, error => faults.push(error))
    queue.wake()
    try {
      const first = await x.connect(x.stories.latestSequence(x.story.id))
      first.controller.abort()
      expect(x.stories.run(run.id).status).toBe('running')
      finish(); await queue.idle()
      expect(x.stories.run(run.id)).toMatchObject({ status: 'completed', draft: '生成中的完整草稿' })
      const second = await x.connect()
      const seen: StoryNotice[] = []
      while (!seen.some(event => event.type === 'run.status' && event.data.status === 'completed')) seen.push((await second.next())!)
      expect(seen.some(event => event.type === 'run.draft')).toBe(true)
      expect(faults).toEqual([])
    } finally { finish(); await queue.close() }
  })

  it('rejects future cursors and closes an existing stream when its administrator session is revoked', async () => {
    const x = await setup()
    const future = await fetch(`${x.url}/api/stories/${x.story.id}/events?after=99999`, { headers: { cookie: x.cookie } })
    expect(future.status).toBe(409)
    expect((await future.json()).error.code).toBe('SSE_CURSOR_AHEAD')
    const stream = await x.connect()
    expect((await stream.next())?.type).toBe('story.created')
    await x.auth.setPassword('replacement-stream-password')
    expect(await stream.next()).toBe(null)
    expect((await fetch(`${x.url}/api/stories/${x.story.id}/events`, { headers: { cookie: x.cookie } })).status).toBe(401)
  })
})
