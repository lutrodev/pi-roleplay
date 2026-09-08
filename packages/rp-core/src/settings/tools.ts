import { objectInput } from '../input.ts'
import { requireValue } from '../errors.ts'

export interface ToolSettings {
  commandTimeoutMs: number
  maxOutputBytes: number
  maxParallelToolCalls: number
  search: { baseUrl: string; model: string; maxUses: number }
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  commandTimeoutMs: 300000,
  maxOutputBytes: 65536,
  maxParallelToolCalls: 1,
  search: { baseUrl: '', model: '', maxUses: 5 },
}

export function normalizeToolSettings(input: unknown): ToolSettings {
  objectInput(input)
  requireValue(Object.keys(input).sort().join(',') === Object.keys(DEFAULT_TOOL_SETTINGS).sort().join(','), 'INVALID_TOOL_SETTINGS', '请提交完整的工具设置，不可包含未知字段。')
  requireValue(Number.isSafeInteger(input.commandTimeoutMs) && Number(input.commandTimeoutMs) >= 1 && Number(input.commandTimeoutMs) <= 300000,
    'INVALID_TOOL_SETTINGS', '命令超时必须在 1 到 300000 毫秒之间。')
  requireValue(Number.isSafeInteger(input.maxOutputBytes) && Number(input.maxOutputBytes) >= 1 && Number(input.maxOutputBytes) <= 1048576,
    'INVALID_TOOL_SETTINGS', '工具输出上限必须在 1 到 1048576 字节之间。')
  requireValue(Number.isSafeInteger(input.maxParallelToolCalls) && Number(input.maxParallelToolCalls) >= 1 && Number(input.maxParallelToolCalls) <= 8,
    'INVALID_TOOL_SETTINGS', '并行工具调用数必须在 1 到 8 之间。')
  objectInput(input.search)
  const search = input.search
  requireValue(Object.keys(search).sort().join(',') === 'baseUrl,maxUses,model' && typeof search.baseUrl === 'string' && typeof search.model === 'string' && search.model.length <= 200 && Number.isInteger(search.maxUses) && Number(search.maxUses) >= 1 && Number(search.maxUses) <= 5,
    'INVALID_TOOL_SETTINGS', '搜索地址、模型或调用上限不正确。')
  const baseUrl = search.baseUrl.trim(), model = search.model.trim()
  requireValue(baseUrl.length <= 4096 && (baseUrl === '' && model === '' || baseUrl !== '' && model !== ''), 'INVALID_TOOL_SETTINGS', '搜索地址和模型需要同时填写，或同时留空。')
  if (baseUrl) {
    requireValue(URL.canParse(baseUrl), 'INVALID_TOOL_SETTINGS', '搜索需要完整的 HTTP(S) 地址。')
    const url = new URL(baseUrl)
    requireValue(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'INVALID_TOOL_SETTINGS', '搜索地址不能包含密钥、查询参数或登录信息。')
  }
  return { commandTimeoutMs: Number(input.commandTimeoutMs), maxOutputBytes: Number(input.maxOutputBytes), maxParallelToolCalls: Number(input.maxParallelToolCalls),
    search: { baseUrl, model, maxUses: Number(search.maxUses) } }
}
