import { afterEach, describe, expect, it } from 'vitest'
import { QuestionService } from '../apps/server/src/services/question-service.ts'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { fixture, profile } from './helpers.ts'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => { for (const x of fixtures.splice(0)) x.close() })
function setup() {
  const x = fixture(); fixtures.push(x)
  const config = profile(); config.runtime.executionMode = 'agent'
  const story = x.stories.create('回答问题', config)
  const run = x.stories.enqueue({ storyId: story.id, requestId: 'q-run', inputHash: 'test', turnId: 'q-turn' }, () => {}).run
  return { ...x, story, run, service: new QuestionService(x.stories) }
}
const questions = [{ id: 'direction', question: '往哪里走？', options: [{ label: '灯塔' }, { label: '海边' }], multiSelect: false },
  { id: 'items', question: '带哪些物品？', options: [{ label: '灯' }, { label: '地图' }], multiSelect: true }]
const answers = [{ id: 'direction', selected: ['灯塔'] }, { id: 'items', selected: ['灯', '地图'], custom: '沿途留意脚印' }]

describe('durable questions', () => {
  it('persists a question batch, validates complete answers and resumes exactly once', async () => {
    const x = setup(); x.stories.setRunStatus(x.run.id, 'running')
    const waiting = x.service.ask(x.run.id, 'call-ask', questions, new AbortController().signal)
    expect(x.stories.run(x.run.id).status).toBe('waiting_user')
    const other = new AppDatabase(x.filename)
    const request = new StoryRepository(other).snapshot(x.story.id).questions[0]!
    other.close()
    expect(request).toMatchObject({ questions, status: 'pending' })
    expect(() => x.service.answer(x.story.id, request.id, [answers[0]])).toThrow('全部问题')
    expect(() => x.service.answer(x.story.id, request.id, [{ id: 'direction', selected: ['灯塔', '海边'] }, answers[1]])).toThrow('多个答案')
    expect(x.stories.run(x.run.id).status).toBe('waiting_user')
    expect(x.service.answer(x.story.id, request.id, answers)).toEqual({ answers, duplicate: false })
    expect(await waiting).toEqual({ answers })
    expect(x.stories.run(x.run.id).status).toBe('running')
    expect(x.service.answer(x.story.id, request.id, answers).duplicate).toBe(true)
    expect(() => x.service.answer(x.story.id, request.id, [{ id: 'direction', selected: ['海边'] }, answers[1]])).toThrow('不同的回答')
    expect(await x.service.ask(x.run.id, 'call-ask', questions, new AbortController().signal)).toEqual({ answers })
  })

  it('accepts a free-text answer without forcing one of the suggested options', async () => {
    const x = setup(); x.stories.setRunStatus(x.run.id, 'running')
    const waiting = x.service.ask(x.run.id, 'free', [{ id: 'name', question: '人物叫什么？' }], new AbortController().signal)
    const request = x.stories.snapshot(x.story.id).questions[0]!
    x.service.answer(x.story.id, request.id, [{ id: 'name', selected: [], custom: ' 林澈 ' }])
    expect(await waiting).toEqual({ answers: [{ id: 'name', selected: [], custom: '林澈' }] })
  })

  it('cancels a waiting run through the queue and does not leave a pending question', async () => {
    const x = setup()
    const queue = new RunQueue(x.stories, (id, signal) => x.service.ask(id, 'cancel-me', questions, signal), error => { throw error })
    queue.wake()
    await expect.poll(() => x.stories.run(x.run.id).status).toBe('waiting_user')
    await queue.cancel(x.run.id); await queue.idle()
    expect(x.stories.run(x.run.id).status).toBe('cancelled')
    expect(x.stories.snapshot(x.story.id).questions[0]?.status).toBe('cancelled')
  })

  it('keeps interrupted questions visible but refuses answers after process recovery', async () => {
    const x = setup(); x.stories.setRunStatus(x.run.id, 'running')
    const controller = new AbortController(), waiting = x.service.ask(x.run.id, 'interrupted', questions, controller.signal)
    const rejected = expect(waiting).rejects.toBeDefined()
    x.stories.recoverInterrupted()
    const request = x.stories.snapshot(x.story.id).questions[0]!
    expect(request.status).toBe('cancelled')
    expect(() => new QuestionService(x.stories).answer(x.story.id, request.id, answers)).toThrow('中断')
    controller.abort(); await rejected
    expect(x.stories.run(x.run.id).status).toBe('interrupted')
  })
})
