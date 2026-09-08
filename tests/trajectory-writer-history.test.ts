import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ContextService } from '../apps/server/src/services/context-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { TraceService } from '../apps/server/src/services/trace-service.ts'
import { RunExecutor } from '../apps/server/src/runtime/executor.ts'
import { ModelRegistry } from '../apps/server/src/runtime/models.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { TraceTimeline } from '../apps/web/src/pages/story/trajectory/timeline.tsx'
import { isError, ledgerRows, usageTotals } from '../apps/web/src/pages/story/trajectory/model.ts'
import { fixture, profile } from './helpers.ts'
import { historyConfig } from './writer-history-fixture.ts'

it.each(['chat', 'agent'] as const)('retains frozen Writer preset traces under the owning attempt after reroll/delete in %s', async mode => {
  const x = fixture(), config = profile(); config.runtime.executionMode = mode
  const story = x.stories.create('Writer 预置历史归属验收', config), service = new StoryService(x.stories, x.assets, x.files), trace = new TraceService(x.stories)
  const history = new WriterHistoryService(x.assets); history.update(1, historyConfig())
  const route = { provider: 'test', model: 'writer' }; let requests = 0
  const models = new ModelRegistry([{ ...route, keyEnv: 'SYNTHETIC', api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', contextWindow: 100000, maxTokens: 8000 }], { env: () => 'synthetic', fetch: async () => {
    const step = requests++ % 3, name = step === 0 ? 'rp_write_turn' : 'rp_commit_turn', args = step === 0 ? { action: 'write' } : mode === 'agent' ? { narrative: '灯塔的新正文。' } : {}
    const delta = step === 1 ? { role: 'assistant', content: '灯塔的新正文。' } : { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: step === 1 ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const executor = new RunExecutor(x.stories, new ContextService(x.stories, x.assets), new TurnService(x.stories), models, x.files)
  const faults: unknown[] = []
  const queue = new RunQueue(x.stories, (id, signal) => executor.execute(id, signal, { routes: { main: route, writer: route }, files: [], images: [], readonlyTools: [], specialists: [], tools: () => [], writerHistory: history.capture() }), error => faults.push(error))
  try {
    const first = service.send(story.id, 'first', [{ text: '开始灯塔故事。', attachmentIds: [] }]).run
    queue.wake(); await queue.idle(); expect(x.stories.run(first.id).status).toBe('completed')
    const changed = historyConfig(); changed.rounds[0]!.user = '第二次尝试使用的新预置输入'; history.update(2, changed)
    const before = x.stories.snapshot(story.id), latest = service.regenerate(story.id, before.revision, before.messages.at(-1)!.id, 'retry').run
    queue.wake(); await queue.idle(); expect(x.stories.run(latest.id).status).toBe('completed')
    const page = trace.conversation(story.id), round = page.rounds[0]!, data = round.trajectory
    expect(page.totalRounds).toBe(1); expect(round.attempts).toHaveLength(2); expect(data.run.id).toBe(latest.id)
    expect(data.agents).toHaveLength(1)
    const writer = data.agents[0]!, preset = data.entries.filter(entry => entry.history)
    expect(preset).toHaveLength(10); expect(preset.every(entry => entry.agentId === writer.id)).toBe(true)
    expect(new Set(preset.map(entry => entry.history!.round))).toEqual(new Set([1, 2]))
    expect(usageTotals(data.requests).count).toBe(3)
    expect(data.entries.filter(entry => !entry.history && entry.kind === 'tool')).toHaveLength(2)
    expect(data.entries.filter(isError)).toEqual([])
    expect(ledgerRows(data, 'main', new Set(), false, false).some(row => row.entry.history)).toBe(false)
    expect(ledgerRows(data, writer.id, new Set(), false, false).filter(row => row.entry.history)).toHaveLength(10)
    const timeline = renderToStaticMarkup(createElement(TraceTimeline, { rounds: [round], scope: writer.id, actual: false, selected: null, select: () => {}, now: Date.now() }))
    expect(timeline).not.toContain('预置'); expect(timeline).not.toContain('read_log'); expect(timeline).not.toContain('check_access')
    const old = trace.trajectory(first.id)
    expect(old.entries.find(entry => entry.history)?.preview).toBe('查阅灯塔值班记录。')
    expect(preset[0]!.preview).toBe('第二次尝试使用的新预置输入')
    for (const run of [first, latest]) {
      const original = trace.trajectory(run.id), owner = original.agents[0]!, request = original.requests.find(request => request.parentCallId === owner.id)!
      const detail = JSON.stringify(trace.request(run.id, request.id))
      expect(detail).toContain('900719925474099312345')
      expect(detail).toContain('historyMessagesJson')
    }
    const current = x.stories.snapshot(story.id); service.remove(story.id, current.revision, current.messages.at(-1)!.id)
    const remaining = trace.conversation(story.id).rounds[0]!
    expect(remaining.state).toBe('input-only'); expect(remaining.trajectory.entries.map(entry => entry.kind)).toEqual(['user'])
    expect(remaining.trajectory.agents).toEqual([]); expect(remaining.trajectory.run.draft).toBe('')
    expect(trace.trajectory(latest.id).entries.filter(entry => entry.history)).toHaveLength(10)
    expect(faults).toEqual([])
  } finally { await queue.close(); x.close() }
})
