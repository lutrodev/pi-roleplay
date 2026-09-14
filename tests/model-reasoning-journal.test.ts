import { expect, it } from 'vitest'
import { fixture, profile } from './helpers.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { RunJournal } from '../apps/server/src/runtime/journal.ts'
import { journalStream } from '../apps/server/src/runtime/model-journal.ts'

it('records resolved intent and final SDK request fields separately and exposes both in request details', async () => {
  const x = fixture(), bodies: Record<string, unknown>[] = [], route = { provider: 'synthetic', model: 'alias' }
  try {
    const story = x.stories.create('参数证据', profile())
    const { run } = new StoryService(x.stories, x.assets, x.files).send(story.id, 'reasoning-evidence', [{ text: '继续', attachmentIds: [] }])
    x.stories.setRunStatus(run.id, 'running')
    const journal = new RunJournal(x.stories, x.files, run), models = new ModelRegistry([{ ...route, keyEnv: 'SYNTHETIC', api: 'openai-completions', baseUrl: 'https://model.test/v1',
      reasoningControl: { mode: 'effort', format: 'openai', levels: { low: 'low', high: 'high' }, off: 'none' }, defaultReasoningEffort: 'low' }], {
      env: () => 'synthetic-private-key', fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    for (const reasoningEffort of [undefined, 'off', 'provider-default']) {
      const selected = { ...route, reasoningEffort }, { model } = models.resolve(selected)
      const stream = await models.bindReasoning(selected, journalStream(journal, models, 'main'))(model, { messages: [{ role: 'user', content: 'test', timestamp: 0 }] })
      expect((await stream.result()).stopReason).toBe('stop')
    }
    const events = x.stories.eventLog(story.id).filter(event => event.type === 'model.message')
    const requests = events.filter(event => event.data.role === 'provider:request')
    expect(requests.map(event => event.data.message.reasoning)).toMatchObject([
      { requested: 'model-default', effective: 'low', source: 'model-default' },
      { requested: 'off', effective: 'off', source: 'selection' },
      { requested: 'provider-default', effective: 'provider-default', source: 'selection' },
    ])
    const parameters = events.filter(event => event.data.role === 'provider:parameters').map(event => event.data.message.parameters)
    expect(parameters).toEqual(bodies.map(body => ({ ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}), max_completion_tokens: body.max_completion_tokens })))
    expect(JSON.stringify(parameters)).not.toContain('synthetic-private-key')
    const detail = new TraceService(x.stories).request(run.id, String(requests[1]!.data.message.requestId))
    expect(detail.records.map(event => event.data.role)).toEqual(['provider:request', 'provider:parameters', 'provider:response'])
  } finally { x.close() }
})
