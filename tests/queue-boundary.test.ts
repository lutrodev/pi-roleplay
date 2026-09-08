import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { TurnService } from '../apps/server/src/services/turn-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { fixture, message, profile } from './helpers.ts'

const close: (() => void)[] = []
afterEach(() => close.splice(0).forEach(clean => clean()))
function setup() {
  const x = fixture(); close.push(x.close)
  const story = x.stories.create('提交边界', profile()), turns = new TurnService(x.stories)
  const service = new StoryService(x.stories, x.assets, x.files)
  const run = service.send(story.id, 'first', [{ text: '继续', attachmentIds: [] }]).run
  const commit = async () => {
    const context = x.stories.append(story.id, { type: 'context.built', data: { runId: run.id, writerPrompt: '', parentPrompt: '', sources: [], model: { provider: 'test', model: 'test' } } })
    turns.recordWriter(run.id, 'writer', context.seq, '正文已经保存。')
    await turns.commit(run.id, randomUUID(), '', {})
  }
  return { ...x, story, service, run, commit }
}
describe('durable commit boundary', () => {
  it('keeps a committed run completed when cancellation arrives before the executor returns', async () => {
    const x = setup(), faults: unknown[] = []
    const queue = new RunQueue(x.stories, async () => { await x.commit(); await queue.cancel(x.run.id); throw new Error('unwinding cancelled executor') }, error => faults.push(error))
    queue.wake(); await queue.idle(); await queue.close()
    expect(x.stories.run(x.run.id)).toMatchObject({ status: 'completed', error: null })
    expect(x.stories.snapshot(x.story.id).messages.at(-1)?.text).toBe('正文已经保存。')
    expect(faults).toEqual([])
  })
  it('recovers a committed run without resending it after a crash between commit and completion status', async () => {
    const x = setup(); x.stories.setRunStatus(x.run.id, 'running'); await x.commit()
    expect(x.stories.recoverInterrupted()).toBe(1)
    expect(x.stories.run(x.run.id).status).toBe('completed')
    expect(x.stories.nextQueued()).toBeUndefined()
  })
  it('regenerates a failed turn from its last visible user message despite later internal tool owners', () => {
    const x = setup(); x.stories.setRunStatus(x.run.id, 'running')
    const user = x.stories.snapshot(x.story.id).messages[0]!
    x.stories.append(x.story.id, { type: 'message.added', data: { message: message('assistant', '', { kind: 'tool', runId: x.run.id, turnId: x.run.turnId }) } })
    x.stories.setRunStatus(x.run.id, 'failed', { code: 'MODEL_FAILED', message: '测试模型中断' })
    const retry = x.service.regenerate(x.story.id, x.stories.latestSequence(x.story.id), user.id, 'retry')
    expect(retry.run.status).toBe('queued')
    expect(x.stories.snapshot(x.story.id).messages.map(item => [item.kind, item.text])).toEqual([['message', '继续']])
  })
})
