import type { createServer } from '../../apps/server/src/server.ts'
import { historyConfig } from '../writer-history-fixture.ts'

/** Only original, synthetic conversations in the independent browser fixture. */
export async function seedTrajectoryMutations(app: Awaited<ReturnType<typeof createServer>>) {
  const names = ['同轮重试与 Writer 历史验收', '删除回复轨迹验收', '清空轨迹验收']
  if (app.stories.list().some(story => story.title === names[0])) return
  const history = historyConfig(); app.writerHistory.update(app.writerHistory.snapshot().revision, history)
  const send = async (id: string, text: string) => { app.service.send(id, crypto.randomUUID(), [{ text, attachmentIds: [] }]); app.queue.wake(); await app.queue.idle() }
  const story = app.service.create(names[0]!)
  await send(story.id, '请从灯塔门口开始这段故事。')
  for (let attempt = 2; attempt <= 3; attempt++) {
    history.rounds[0]!.user = `第 ${attempt} 次尝试注入的灯塔记录。`
    app.writerHistory.update(app.writerHistory.snapshot().revision, history)
    const current = app.stories.snapshot(story.id)
    app.service.regenerate(story.id, current.revision, current.messages.filter(m => m.kind !== 'tool').at(-1)!.id, crypto.randomUUID())
    app.queue.wake(); await app.queue.idle()
  }
  await send(story.id, '现在核对两封来信上的邮戳。')
  const removed = app.service.create(names[1]!)
  await send(removed.id, '保留这条灯塔输入。'); await send(removed.id, '这轮应随前面的回复一起删除。')
  let current = app.stories.snapshot(removed.id)
  app.service.remove(removed.id, current.revision, current.messages.find(m => m.role === 'assistant' && m.kind !== 'tool')!.id)
  const empty = app.service.create(names[2]!); await send(empty.id, '这轮随后会被清空。')
  current = app.stories.snapshot(empty.id); app.service.remove(empty.id, current.revision, current.messages[0]!.id)
}
