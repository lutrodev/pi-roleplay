import { randomUUID } from 'node:crypto'
import type { createServer } from '../../apps/server/src/server.ts'
import type { StoryEventInput } from '../../packages/rp-core/src/types.ts'

/** Explicitly synthetic ledger for browser QA: parallel agents, nesting, retries and long inputs. */
export function seedTrajectoryScenario(app: Pick<Awaited<ReturnType<typeof createServer>>, 'stories' | 'service' | 'database'>) {
  if (app.stories.list().some(story => story.title === '轨迹交互验收')) return
  const story = app.service.create('轨迹交互验收')
  const { run } = app.service.send(story.id, 'trajectory-scenario', [{ text: '核对灯塔的旧海图，再续写林舟与青禾的相遇。', attachmentIds: [] }])
  app.stories.setRunStatus(run.id, 'running')
  const start = Date.now() - 22000
  app.database.sqlite.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(new Date(start).toISOString(), run.id)
  app.database.sqlite.prepare("UPDATE events SET created_at = ? WHERE story_id = ? AND type = 'message.added'").run(new Date(start).toISOString(), story.id)
  const add = (event: StoryEventInput, offset: number) => {
    const saved = app.stories.append(story.id, event)
    app.database.sqlite.prepare('UPDATE events SET created_at = ? WHERE story_id = ? AND seq = ?').run(new Date(start + offset).toISOString(), story.id, saved.seq)
  }
  const tool = (id: string, name: string, args: Record<string, string>, offset: number, parentCallId?: string) => add({ type: 'tool.started', data: { callId: id, runId: run.id, name, arguments: args, status: 'running', ...(parentCallId ? { parentCallId } : {}) } }, offset)
  const result = (callId: string, text: string, offset: number, failed = false) => add({ type: 'tool.finished', data: { callId, result: { content: [{ type: 'text', text }], details: { text } }, failed } }, offset)
  const model = (scope: string, parentCallId: string | undefined, offset: number, elapsedMs: number, prompt: string, reply: string, failed = false) => {
    const requestId = randomUUID(), ownerMessageId = parentCallId ?? requestId
    const fields = { requestId, scope, ...(parentCallId ? { parentCallId } : {}) }
    add({ type: 'model.message', data: { runId: run.id, ownerMessageId, role: 'provider:request', message: { ...fields, provider: 'browser-fixture', model: scope === 'main' ? 'DeepSeek · 主模型' : scope.startsWith('writer:') ? 'Writer · 创作模型' : '校对模型', systemPrompt: '你正在参与灯塔故事。忠实保留已发生的事实，并按任务边界工作。', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [{ name: 'read', description: '读取当前任务的资料。', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] } } }, offset)
    add({ type: 'model.message', data: { runId: run.id, ownerMessageId, role: 'provider:response', message: { ...fields, elapsedMs, firstTokenMs: 240, response: { role: 'assistant', stopReason: failed ? 'error' : 'stop', content: [{ type: 'thinking', thinking: '先核对事件发生的顺序，再组织回应。' }, { type: 'text', text: reply }], ...(failed ? { errorMessage: '资料读取暂时失败，稍后重新尝试。' } : {}), usage: { input: 1840, output: 320, cacheRead: 480, cacheWrite: 0, totalTokens: 2640 } } } } }, offset + elapsedMs)
  }
  model('main', undefined, 0, 900, '核对旧海图并继续灯塔中的故事。', '安排 Writer 撰写回复，同时核对海图资料。')
  const writer = 'fixture-writer', lore = 'fixture-lore', review = 'fixture-review'
  tool(writer, 'rp_write_turn', { action: 'write', task: '续写林舟与青禾在灯塔的对话。' }, 1000)
  tool(lore, 'rp_run_subagent', { subagent: '海图核对', task: '核对灯塔与旧海图中的地名。' }, 1100)
  model('writer:fixture', writer, 1200, 2600, '请先梳理人物关系。\n\n' + '青禾守着灯塔，林舟带着匿名信来到海岸。\n'.repeat(120) + '\n关键词：蓝色邮戳', '需要核对信件与海图之间的联系。')
  tool(review, 'rp_run_subagent', { subagent: '情节校对', task: '检查两封信的日期与人物动机。' }, 4000, writer)
  model('task:review', review, 4100, 1100, '核对两封信的日期。', '内部校对失败，请重试。', true)
  model('task:review', review, 5400, 1300, '重新核对两封信的日期。', '日期一致，两封信均在涨潮前寄出。')
  result(review, '校对完成：日期一致，人物动机无冲突。', 6800)
  for (let index = 0; index < 10; index++) {
    const id = `fixture-read-${index}`
    tool(id, 'read', { path: `海图/档案-${index + 1}.md` }, 1800 + index * 500, lore)
    result(id, `已读取第 ${index + 1} 份档案，灯塔位于雾港北岸。`, 2000 + index * 500)
  }
  model('task:lore', lore, 7200, 1800, '汇总已读取的海图资料。', '旧灯塔位于雾港北岸，海图标注与故事设定一致。')
  result(lore, '已核对 10 份资料，地名与航线一致。', 9300)
  model('writer:fixture', writer, 9900, 6900, '根据核对结果继续写作。', '雨停的时候，灯塔里的钟响了三下。\n\n青禾把旧海图推到灯下，指尖停在一枚蓝色邮戳旁。\n\n“这条航线，你还记得吗？”\n\n林舟没有立刻回答。潮声从半开的窗外涌进来，像一句迟到多年的回信。')
  result(writer, '青禾将旧海图推到灯下，两人发现了匿名信与旧航线的联系。', 17000)
  model('main', undefined, 17300, 1600, '合并写作与资料核对结果。', '写作和核对已完成，现在提交这一段剧情。')
  tool('fixture-commit-failed', 'rp_commit_turn', { runSummary: '继续调查旧航线' }, 19000)
  result('fixture-commit-failed', '变量版本发生变化，需要重新核对后提交。', 19200, true)
  tool('fixture-commit-retry', 'rp_commit_turn', { runSummary: '核对变量后提交剧情' }, 19600)
  result('fixture-commit-retry', '剧情已提交。', 20000)
  add({ type: 'message.added', data: { message: { id: randomUUID(), role: 'assistant', kind: 'message', text: '青禾将旧海图推到灯下。\n\n“这条航线，你还记得吗？”', runId: run.id, turnId: run.turnId, attachmentIds: [], createdAt: new Date(start + 20100).toISOString() } } }, 20100)
  app.stories.setRunStatus(run.id, 'completed')
  app.database.sqlite.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(new Date(start + 20100).toISOString(), run.id)
  seedRound(app, story.id, 2, '沿着旧海图，检查码头留下的线索。', '码头的仓库里留着一盏灯。青禾发现了一张写着日期的船票。')
  seedRound(app, story.id, 3, '先停在这里，我想调整一下调查方向。', '正在核对下一段的调查方向。', true)
  const longStory = app.service.create('跨轮轨迹分页验收')
  for (let round = 1; round <= 16; round++) seedRound(app, longStory.id, round, `继续调查第 ${round} 处线索。`, round === 1 || round === 15 ? `蓝色邮戳的线索出现在第 ${round} 处档案中。` : `已核对第 ${round} 处线索，准备下一步调查。`)
}

function seedRound(app: Pick<Awaited<ReturnType<typeof createServer>>, 'stories' | 'service' | 'database'>, storyId: string, round: number, input: string, output: string, stopped = false) {
  const { run } = app.service.send(storyId, `conversation-trajectory-${round}`, [{ text: input, attachmentIds: [] }])
  app.stories.setRunStatus(run.id, 'running')
  const requestId = randomUUID(), ownerMessageId = requestId, callId = `${run.id}-read`
  app.stories.append(storyId, { type: 'model.message', data: { runId: run.id, ownerMessageId, role: 'provider:request', message: { requestId, scope: 'main', provider: 'browser-fixture', model: '合成验收模型', systemPrompt: '忠实保留灯塔故事中已发生的事实。', messages: [{ role: 'user', content: input }] } } })
  app.stories.append(storyId, { type: 'model.message', data: { runId: run.id, ownerMessageId, role: 'provider:response', message: { requestId, elapsedMs: 1200, firstTokenMs: 100, response: { stopReason: stopped ? 'aborted' : 'stop', content: [{ type: 'text', text: output }], usage: { input: 500, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 580 } } } } })
  if (!stopped) {
    app.stories.append(storyId, { type: 'tool.started', data: { callId, runId: run.id, name: 'read', arguments: { path: `archive-${round}.md` }, status: 'running' } })
    app.stories.append(storyId, { type: 'tool.finished', data: { callId, result: { text: `已读取第 ${round} 轮档案。` }, failed: false } })
    app.stories.append(storyId, { type: 'message.added', data: { message: { id: randomUUID(), role: 'assistant', kind: 'message', text: output, runId: run.id, turnId: run.turnId, attachmentIds: [], createdAt: new Date().toISOString() } } })
  }
  app.stories.setRunStatus(run.id, stopped ? 'cancelled' : 'completed', stopped ? { code: 'CANCELLED', message: '已停止生成。' } : undefined)
}
