import { setTimeout as pause } from 'node:timers/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { createServer } from '../../apps/server/src/server.ts'
import { streamingTextResponse } from '../streaming-response.ts'
import { activityResponse } from './activity-response.ts'

const marker = 'BROWSER_SUBAGENT_PROGRESS_TEST'
interface ProviderBody {
  messages: { role: string; content?: unknown; tool_calls?: unknown[] }[]
  tools?: { function: { name: string; parameters?: { anyOf?: unknown; properties?: { subagent?: { enum?: string[] } } } } }[]
}
/** Synthetic provider only; real Pi task loops, tools, journals and queue run unchanged. */
export async function subagentResponse(body: ProviderBody, signal?: AbortSignal | null): Promise<Response | undefined> {
  if (!JSON.stringify(body.messages).includes(marker)) return
  const task = body.tools?.find(tool => tool.function.name === 'rp_run_subagent')
  if (task) {
    if (body.messages.at(-1)?.role === 'tool') return streamingTextResponse('两项资料核对已结束，可以在协作进展中查看结果。', signal)
    const ids = task.function.parameters?.properties?.subagent?.enum
    if (!ids?.length) throw new Error('Task fixture needs enabled subagents')
    const delta = { role: 'assistant', content: '', tool_calls: [0, 1].map(index => ({ index, id: `collaboration-${index}`, type: 'function', function: {
      name: 'rp_run_subagent', arguments: JSON.stringify({ subagent: ids[index % ids.length], task: index ? '检查人物语气与行动是否一致。' : '读取灯塔档案，核对地点和时间。', input: { fixture: marker, reviewer: index } }),
    } })) }
    return new Response(`data: ${JSON.stringify({ id: 'collaboration-main', choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  const input = JSON.stringify(body.messages)
  if (/reviewer\\?"\s*:\s*0/.test(input)) {
    if (body.messages.some(message => message.role === 'tool')) return streamingTextResponse('已读取灯塔档案。地点位于雾港北岸，信件寄出时间和人物行程一致。', signal)
    return activityResponse('正在读取灯塔档案，核对地点和时间。', { name: 'read', args: { file_path: 'lighthouse.txt' } }, signal)
  }
  await pause(8000, undefined, { signal: signal ?? undefined })
  return streamingTextResponse('正在检查人物语气与行动。青禾的回应符合守灯人的设定，林舟携带来信的动机清楚。'.repeat(12), signal)
}
export async function seedSubagentProgress(app: Awaited<ReturnType<typeof createServer>>, workspaces: string) {
  const settings = app.toolSettings.snapshot()
  app.toolSettings.update(settings.revision, { ...settings.settings, maxParallelToolCalls: 2 })
  const story = app.service.create('子代理协作验收', { runtime: { executionMode: 'agent' } })
  await mkdir(join(workspaces, story.id), { recursive: true })
  await writeFile(join(workspaces, story.id, 'lighthouse.txt'), '灯塔位于雾港北岸。两封信在涨潮前寄出。')
  return story.id
}
