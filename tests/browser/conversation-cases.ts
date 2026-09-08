/** Additional real HTTP cases on the isolated synthetic browser fixture, never a user environment. */
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import type { RunRecord, StorySnapshot } from '../../packages/rp-core/src/types.ts'
import type { Preferences } from '../../packages/rp-core/src/settings/preferences.ts'

const origin = new URL(process.argv[2] ?? '')
if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' || ['3080', '3091', ''].includes(origin.port)) throw new Error('Use an independent synthetic browser fixture port.')
const login = await fetch(`${origin.origin}/api/auth/login`, { method: 'POST', headers: { origin: origin.origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'browser-test-password-2026' }) })
if (!login.ok) throw new Error('This is not the browser test fixture.')
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${origin.origin}/api${path}`, { method, headers: { cookie, origin: origin.origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
const models = await call<{ models: { provider: string }[] }>('/settings/models')
if (!models.models.length || models.models.some(model => model.provider !== 'browser-fixture')) throw new Error('Refusing to seed a real model environment.')
async function send(storyId: string, text: string) {
  const { run } = await call<{ run: RunRecord }>(`/stories/${storyId}/messages`, 'POST', { requestId: randomUUID(), inputs: [{ text, attachmentIds: [] }] })
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await call<{ run: RunRecord }>(`/runs/${run.id}`)
    if (!['queued', 'running', 'waiting_user'].includes(result.run.status)) return result.run
    await pause(100)
  }
  throw new Error('Synthetic case timed out.')
}
// The one-step budget genuinely fails after Writer; the application preserves its recoverable draft.
const failed = await call<{ story: StorySnapshot }>('/stories', 'POST', { title: '中断恢复 · 界面验收', profile: { runtime: { maxSteps: 1, executionMode: 'agent' } } })
const failure = await send(failed.story.id, '请她讲述灯塔的来历。')
if (failure.status !== 'failed' || !failure.draft) throw new Error('Expected a real pre-commit failure with prose.')
const recovery = await call<{ story: StorySnapshot }>(`/stories/${failed.story.id}`)
if (recovery.story.messages.filter(message => message.kind === 'draft').length !== 1 || recovery.story.messages.some(message => message.kind === 'narrative')) throw new Error('Invalid draft recovery fixture.')

const longId = process.argv[3]
if (!longId) throw new Error('Supply the original long-story fixture ID.')
const first = await send(longId, 'BROWSER_STATE_TEST · 检查窗边的海图。')
const second = await send(longId, 'BROWSER_STATE_TEST · 继续调查灯塔。')
if (first.status !== 'completed' || second.status !== 'completed') throw new Error('State update scenario failed.')
const current = await call<{ story: StorySnapshot }>(`/stories/${longId}`)
const earlierReply = current.story.messages.find(message => message.runId === first.id && message.kind === 'narrative')
if (!earlierReply) throw new Error('Missing historical narrative.')
const boundary = await call<{ before: StorySnapshot['state']; after: StorySnapshot['state'] }>(`/stories/${longId}/messages/${earlierReply.id}/state`)
if (boundary.before.namespaces.story?.value.energy !== 10 || boundary.after.namespaces.story?.value.energy !== 9 || current.story.state.namespaces.story?.value.energy !== 8) throw new Error('Historical state fixture is not 10 → 9 with current 8.')
const settings = await call<{ revision: number; preferences: Preferences }>('/settings')
await call('/settings', 'PUT', { expectedRevision: settings.revision, preferences: { ...settings.preferences, reading: { ...settings.preferences.reading, dialogueHighlight: false } } })
console.log(JSON.stringify({ failedStoryId: failed.story.id, failure: failure.status, draftMessages: 1, longStoryId: longId, earlierReplyId: earlierReply.id, before: 10, after: 9, current: 8 }))
