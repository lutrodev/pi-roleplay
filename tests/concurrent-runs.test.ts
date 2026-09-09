import { afterEach, expect, it } from 'vitest'
import { RunQueue } from '../apps/server/src/runtime/queue.ts'
import { QuestionService } from '../apps/server/src/services/question-service.ts'
import { StoryService } from '../apps/server/src/services/story-service.ts'
import { InputQueueService } from '../apps/server/src/services/input-queue-service.ts'
import { fixture, profile } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function setup(execute: ConstructorParameters<typeof RunQueue>[1]) {
  const x = fixture(), service = new StoryService(x.stories, x.assets, x.files), inputs = new InputQueueService(service)
  const faults: unknown[] = [], settled: string[] = [], queue = new RunQueue(x.stories, execute, error => faults.push(error), () => false, () => inputs.promote(), id => settled.push(id))
  cleanup.push(async () => { await queue.close(); x.close() })
  const story = (name: string) => x.stories.create(name, { ...profile(), runtime: { executionMode: 'agent' } })
  const send = (id: string, text: string) => service.send(id, text, [{ text, attachmentIds: [] }]).run
  return { ...x, service, inputs, faults, settled, queue, story, send }
}
function wait(signal: AbortSignal) {
  return new Promise<void>((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
}

it('advances other conversations while one waits for an answer, and resumes the question exactly once', async () => {
  const calls: string[] = []
  const x = setup(async (id, signal) => { calls.push(id); if (id === first.id) await questions.ask(id, 'direction', [{ id: 'go', question: '往哪里走？' }], signal) })
  const questions = new QuestionService(x.stories), a = x.story('等待回答'), b = x.story('独立会话')
  const first = x.send(a.id, 'A'); x.queue.wake()
  await expect.poll(() => x.stories.run(first.id).status).toBe('waiting_user')
  const second = x.send(b.id, 'B'); x.queue.wake()
  await expect.poll(() => x.stories.run(second.id).status).toBe('completed')
  expect(x.stories.run(first.id).status).toBe('waiting_user')
  expect(() => x.send(a.id, '不能直接重叠发送')).toThrow()
  const question = x.stories.snapshot(a.id).questions[0]!, answers = [{ id: 'go', selected: [], custom: '灯塔' }]
  questions.answer(a.id, question.id, answers)
  await x.queue.idle()
  expect(questions.answer(a.id, question.id, answers).duplicate).toBe(true)
  expect(calls).toEqual([first.id, second.id])
  expect(x.settled).toEqual([second.id, first.id])
  expect(x.faults).toEqual([])
})

it('cancels only the selected conversation and promotes its pending inputs in order', async () => {
  const seen: { run: string; text: string[] }[] = []
  const x = setup(async (id, signal) => {
    seen.push({ run: id, text: x.stories.snapshot(x.stories.run(id).storyId).messages.map(item => item.text) })
    if ([first.id, second.id].includes(id)) await wait(signal)
  })
  const a = x.story('A'), b = x.story('B'), first = x.send(a.id, 'A1'), second = x.send(b.id, 'B1')
  x.inputs.submit(a.id, 'input-A2', [{ text: 'A2', attachmentIds: [] }], 'queue')
  x.inputs.submit(a.id, 'input-A3', [{ text: 'A3', attachmentIds: [] }], 'queue')
  x.queue.wake()
  await expect.poll(() => seen.length).toBe(2)
  expect(x.stories.run(first.id).status).toBe('running'); expect(x.stories.run(second.id).status).toBe('running')
  await x.queue.cancel(first.id)
  await expect.poll(() => seen.length).toBe(4)
  expect(x.stories.run(first.id).status).toBe('cancelled')
  expect(x.stories.run(second.id).status).toBe('running')
  expect(seen.find(item => item.run === first.id)?.text).toEqual(['A1'])
  expect(seen[2]!.text).toEqual(['A1', 'A2'])
  expect(seen[3]!.text).toEqual(['A1', 'A2', 'A3'])
  await x.queue.cancel(second.id); await x.queue.idle()
  expect(x.faults).toEqual([])
})

it('isolates failures and interrupts every active or waiting run on shutdown without replaying it', async () => {
  const x = setup(async (id, signal) => {
    if (id === failed.id) throw new Error('one synthetic failure')
    if (id === questionRun.id) await questions.ask(id, 'stop', [{ id: 'answer', question: '等待确认？' }], signal)
    else await wait(signal)
  })
  const questions = new QuestionService(x.stories)
  const failed = x.send(x.story('失败').id, 'fail'), running = x.send(x.story('运行').id, 'run'), questionRun = x.send(x.story('提问').id, 'ask')
  x.queue.wake()
  await expect.poll(() => x.stories.run(questionRun.id).status).toBe('waiting_user')
  expect(x.stories.run(failed.id).status).toBe('failed')
  expect(x.stories.run(running.id).status).toBe('running')
  expect(x.faults).toHaveLength(1)
  await x.queue.close()
  expect(x.stories.run(running.id).status).toBe('interrupted')
  expect(x.stories.run(questionRun.id).status).toBe('interrupted')
  expect(x.stories.snapshot(questionRun.storyId).questions[0]?.status).toBe('cancelled')
  const queued = x.send(x.story('重启后').id, 'later'), executed: string[] = []
  const restored = new RunQueue(x.stories, async id => { executed.push(id) }, error => { throw error })
  restored.start(); await restored.idle(); await restored.close()
  expect(executed).toEqual([queued.id])
  expect(x.stories.run(failed.id).status).toBe('failed')
})
