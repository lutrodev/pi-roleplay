import { randomUUID } from 'node:crypto'
import type { createServer } from '../../apps/server/src/server.ts'
import { TurnService } from '../../apps/server/src/services/turn-service.ts'
import type { RunStatus } from '../../packages/rp-core/src/types.ts'

/** Persisted, synthetic boundary cases for UI QA; recovery actions still use the real HTTP API. */
export async function seedConversationBoundaries(app: Awaited<ReturnType<typeof createServer>>) {
  const cases: Record<string, string> = {}, turns = new TurnService(app.stories)
  const create = async (key: string, title: string, status: RunStatus, options: { draft?: string; committed?: boolean; error?: { code: string; message: string }; input?: string } = {}) => {
    const story = app.service.create(title)
    cases[key] = story.id
    const { run } = app.service.send(story.id, randomUUID(), [{ text: options.input ?? '看看旧海图，再继续灯塔里的对话。', attachmentIds: [] }])
    app.stories.setRunStatus(run.id, 'running')
    if (options.draft) app.stories.saveDraft(run.id, options.draft)
    if (options.committed) {
      const context = app.stories.append(story.id, { type: 'context.built', data: { runId: run.id, writerPrompt: '', parentPrompt: '', sources: [], model: { provider: 'browser-fixture', model: 'test-model' } } })
      turns.recordWriter(run.id, 'boundary-writer', context.seq, '海风吹过窗边。青禾把旧海图展开，指向灯塔以北的一条航线。')
      await turns.commit(run.id, randomUUID(), '', {})
    }
    app.stories.setRunStatus(run.id, status, options.error)
    return story.id
  }
  const draft = '青禾将那封信推到灯下。纸上的蓝色邮戳，恰好与海图角落的印记重合。'
  await create('filtered', '灯塔来信 · 生成未完成', 'failed', { error: { code: 'MODEL_CONTENT_FILTER', message: '模型提供商的内容过滤中止了本轮生成，尚未提交正文。已有草稿和工具记录已保留。' } })
  await create('draft', '灯塔来信 · 草稿已保留', 'failed', { draft, error: { code: 'MAX_STEPS', message: '本轮达到步骤上限，已接收的草稿和工具记录仍保留。' } })
  await create('interrupted', '灯塔来信 · 生成中断', 'interrupted', { draft, error: { code: 'PROCESS_INTERRUPTED', message: '服务重启中断了这次生成。草稿和已执行工具的记录仍保留，请检查后重新生成。' } })
  await create('stopped', '灯塔来信 · 已停止', 'cancelled')
  await create('committed', '灯塔来信 · 正文已保存', 'failed', { committed: true, error: { code: 'SYNTHETIC_FOLLOW_UP', message: '正文提交后的补充处理没有完成。' } })
  await create('long', '灯塔来信 · 长错误原因', 'failed', { error: { code: 'SYNTHETIC_LONG_ERROR', message: '合成测试诊断，未连接真实模型服务。\n' + '服务暂时无法完成请求，请稍后重试。'.repeat(24) + '\nSYNTHETIC_DIAGNOSTIC_' + 'x'.repeat(300) } })
  const summary = await create('summary', '灯塔来信 · 总结未完成', 'completed', { committed: true })
  const suggestions = await create('suggestions', '灯塔来信 · 建议未生成', 'completed', { committed: true })
  await create('summaryBusy', '灯塔来信 · 整理总结', 'completed', { committed: true, input: 'BROWSER_SUMMARY_DELAY_TEST · 梳理灯塔与旧海图的线索。' })
  const archived = await create('archived', '灯塔来信 · 已归档', 'completed', { committed: true })
  app.service.archive(archived, app.stories.snapshot(archived).revision, true)
  cases.empty = app.service.create('空会话 · 界面检查').id
  app.stories.append(summary, { type: 'maintenance.status', data: { id: randomUUID(), kind: 'summary', status: 'failed', trigger: 'manual', code: 'SUMMARY_TIMEOUT', message: '会话总结超时，原始对话保留。' } })
  const last = app.stories.snapshot(suggestions).messages.at(-1)!
  app.stories.append(suggestions, { type: 'maintenance.status', data: { id: randomUUID(), kind: 'reply-options', status: 'failed', messageId: last.id, code: 'REPLY_OPTIONS_FAILED', message: '模型没有返回完整的回复建议。' } })
  return cases
}
