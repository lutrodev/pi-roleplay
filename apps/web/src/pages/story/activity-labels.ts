import type { AgentActivity, ModelActivity } from '../../../../../packages/protocol/src/activity.ts'
import { uiT } from '../../lib/i18n.ts'

export function activityToolName(name: string): string {
  return ({ rp_write_turn: uiT('Writer 写作'), rp_commit_turn: uiT('保存正文与剧情状态'), rp_reply: uiT('整理回复'),
    rp_run_subagent: uiT('子代理协作'), read: uiT('读取文件'), write: uiT('写入文件'), edit: uiT('编辑文件'),
    bash: uiT('执行命令'), web_search: uiT('搜索资料'), skill: uiT('读取技能'), ask_user_question: uiT('向你确认信息'),
  } as Record<string, string>)[name] ?? name
}
export function modelPhaseLabel(phase: ModelActivity['phase'], toolName?: string) {
  if (phase === 'tool') return toolName ? uiT('准备调用：%{name}', { name: activityToolName(toolName) }) : uiT('正在准备工具调用')
  return uiT({ queued: '等待模型名额', waiting: '等待模型响应', thinking: '正在思考', responding: '正在生成结果' }[phase])
}
export function agentStatusLabel(agent: AgentActivity) {
  if (agent.status !== 'running') return uiT({ completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' }[agent.status])
  if (agent.phase === 'tools') return activityToolName(agent.tools.findLast(tool => tool.status === 'running')?.name ?? '') || uiT('正在使用工具')
  if (agent.phase === 'continuing') return uiT('正在继续任务')
  if (agent.phase === 'waiting_user') return uiT('等待你的回答')
  return agent.kind === 'writer' && agent.phase === 'responding' ? uiT('正在写作') : modelPhaseLabel(agent.phase)
}
