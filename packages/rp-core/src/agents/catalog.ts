import { objectInput } from '../input.ts'
import { requireValue } from '../errors.ts'
import type { ModelRoute } from '../types.ts'

export type ModelSelection = { kind: 'inherit'; reasoningEffort?: string } | ({ kind: 'fixed' } & ModelRoute)
export interface TaskSubagentInput {
  name: string
  description: string
  instructions: string
  enabled: boolean
  route: ModelSelection
  tools: ('web_search' | 'skill')[]
}
export interface TaskSubagent extends TaskSubagentInput { id: string; revision: number; createdAt: string; updatedAt: string }
export interface SubagentCatalog { version: 1; writer: { revision: number; route: ModelSelection }; subagents: TaskSubagent[] }

export function normalizeModelSelection(input: unknown): ModelSelection {
  objectInput(input)
  if (input.kind === 'inherit') {
    requireValue(Object.keys(input).every(key => ['kind', 'reasoningEffort'].includes(key)), 'INVALID_MODEL_ROUTE', '跟随主模型时不能同时填写固定模型参数。')
    return { kind: 'inherit', ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: text(input.reasoningEffort, '思考强度', 64) }) }
  }
  requireValue(input.kind === 'fixed' && Object.keys(input).every(key => ['kind', 'provider', 'model', 'reasoningEffort'].includes(key)), 'INVALID_MODEL_ROUTE', '请选择跟随主模型或完整的固定模型配置。')
  return { kind: 'fixed', provider: text(input.provider, '提供商', 64), model: text(input.model, '模型', 200),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: text(input.reasoningEffort, '思考强度', 64) }) }
}

export function resolveModelSelection(selection: ModelSelection, main: ModelRoute): ModelRoute {
  return selection.kind === 'fixed' ? selection : { ...main,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
}

export function normalizeTaskSubagent(input: unknown, enabled = true): TaskSubagentInput {
  objectInput(input)
  requireValue(Object.keys(input).every(key => ['name', 'description', 'instructions', 'enabled', 'route', 'tools'].includes(key)), 'INVALID_SUBAGENT', '子代理包含不支持的字段。')
  const tools = input.tools ?? []
  requireValue(Array.isArray(tools) && tools.every(tool => tool === 'web_search' || tool === 'skill') && new Set(tools).size === tools.length, 'INVALID_SUBAGENT_TOOLS', '任务子代理可选工具只有 web_search 和 skill，不能重复。')
  requireValue(input.enabled === undefined || typeof input.enabled === 'boolean', 'INVALID_SUBAGENT', '子代理启用状态不正确。')
  return { name: text(input.name, '名称', 80), description: text(input.description, '调用说明', 240), instructions: text(input.instructions, '工作指令', 20_000),
    route: normalizeModelSelection(input.route), tools: (['web_search', 'skill'] as const).filter(tool => tools.includes(tool)), enabled: input.enabled === undefined ? enabled : input.enabled }
}

export function subagentNameKey(name: string) { return name.normalize('NFKC').toLocaleLowerCase('en-US') }
function text(value: unknown, label: string, max: number) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= max, 'INVALID_SUBAGENT', `${label}不能为空，且最多 ${max} 字。`)
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
}
