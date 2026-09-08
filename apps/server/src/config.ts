import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeModelSelection } from '../../../packages/rp-core/src/agents/catalog.ts'
import { objectInput } from '../../../packages/rp-core/src/input.ts'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'
import type { ModelRoute } from '../../../packages/rp-core/src/types.ts'
import type { ModelRegistration } from './runtime/models.ts'
import type { SearchConfig } from './runtime/search.ts'

export interface ServerConfig {
  dataDirectory: string
  publicOrigin: string
  sessionKey: Buffer
  tools: { url: string; token: string }
  models: ModelRegistration[]
  defaultMain: ModelRoute | null
  search?: SearchConfig
  skillRoots: { path: string; virtualPath: string }[]
  controlSocket?: string
  webDirectory?: string
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<{ config: ServerConfig; host: string; port: number }> {
  const origin = env.RP_PUBLIC_ORIGIN ?? 'http://localhost:3091', port = Number(env.RP_PORT ?? 3091)
  let parsed: URL
  try { parsed = new URL(origin) } catch { throw new RpError('INVALID_CONFIG', 'RP_PUBLIC_ORIGIN 需要是完整的 HTTP(S) origin。') }
  requireValue(['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin, 'INVALID_CONFIG', 'RP_PUBLIC_ORIGIN 不能包含路径、凭据或查询参数。')
  requireValue(Number.isInteger(port) && port >= 1 && port <= 65535 && port !== 3080, 'INVALID_CONFIG', '应用端口需要为 1–65535，且不能使用旧服务的 3080。')
  requireValue(env.RP_SESSION_KEY_FILE && env.RP_TOOL_TOKEN_FILE, 'INVALID_CONFIG', '请配置 RP_SESSION_KEY_FILE 和 RP_TOOL_TOKEN_FILE；密钥文件由部署初始化脚本创建。')
  const [sessionKey, tokenBytes, modelBytes] = await Promise.all([
    boundedFile(env.RP_SESSION_KEY_FILE, 32), boundedFile(env.RP_TOOL_TOKEN_FILE, 512),
    env.RP_MODELS_FILE ? boundedFile(env.RP_MODELS_FILE, 262144) : Promise.resolve(Buffer.from('{"models":[],"main":null}')),
  ])
  requireValue(sessionKey.length === 32, 'INVALID_CONFIG', 'Cookie 密钥文件需要恰好 32 字节。')
  const token = new TextDecoder('utf-8', { fatal: true }).decode(tokenBytes).trim()
  requireValue(/^[A-Za-z0-9_-]{32,256}$/.test(token), 'INVALID_CONFIG', '工具令牌需要 32–256 位字母、数字、下划线或连字符。')
  let document: unknown
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(modelBytes)) } catch { throw new RpError('INVALID_CONFIG', '模型配置文件不是有效的 UTF-8 JSON。') }
  const modelConfig = parseModelConfig(document)
  const config: ServerConfig = {
    dataDirectory: resolve(env.RP_DATA_DIR ?? './data'), publicOrigin: origin, sessionKey,
    tools: { url: env.RP_TOOLS_URL ?? 'http://tools:3092', token }, models: modelConfig.models, defaultMain: modelConfig.main,
    ...(modelConfig.search ? { search: modelConfig.search } : {}),
    skillRoots: [{ path: resolve(env.RP_BUILTIN_SKILLS_DIR ?? './skills/builtin'), virtualPath: '/skills/builtin' }, { path: resolve(env.RP_CUSTOM_SKILLS_DIR ?? './skills/custom'), virtualPath: '/skills/custom' }],
    ...(env.RP_CONTROL_SOCKET ? { controlSocket: resolve(env.RP_CONTROL_SOCKET) } : {}),
    ...(env.RP_WEB_DIR ? { webDirectory: resolve(env.RP_WEB_DIR) } : {}),
  }
  return { config, host: env.RP_HOST ?? '127.0.0.1', port }
}

export function parseModelConfig(input: unknown): { models: ModelRegistration[]; main: ModelRoute | null; search?: SearchConfig } {
  objectInput(input)
  requireValue(Object.keys(input).every(key => ['models', 'main', 'search'].includes(key)) && Array.isArray(input.models) && input.models.length <= 64, 'INVALID_CONFIG', '模型文件需要 models 列表和可选的 main、search 配置。')
  const fields = new Set(['provider', 'model', 'label', 'keyEnv', 'api', 'baseUrl', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'outputTokens', 'temperature', 'compat'])
  for (const model of input.models) {
    objectInput(model)
    requireValue(Object.keys(model).every(key => fields.has(key)), 'INVALID_CONFIG', '模型包含未知字段；API 密钥只能通过 keyEnv 引用环境变量。')
    for (const key of ['provider', 'model', 'keyEnv']) requireValue(typeof model[key] === 'string' && model[key].length > 0, 'INVALID_CONFIG', '模型需要 provider、model 和 keyEnv。')
    requireValue(model.label === undefined || typeof model.label === 'string' && model.label.length <= 200, 'INVALID_CONFIG', '模型显示名称不正确。')
    requireValue(model.api === undefined || ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(String(model.api)), 'INVALID_CONFIG', '模型 API 类型不受支持。')
    requireValue(model.baseUrl === undefined || typeof model.baseUrl === 'string', 'INVALID_CONFIG', '模型地址必须是文本。')
    requireValue(model.reasoning === undefined || typeof model.reasoning === 'boolean', 'INVALID_CONFIG', '模型思考能力需要布尔值。')
    if (model.compat !== undefined) objectInput(model.compat)
  }
  let main: ModelRoute | null = null
  if (input.main !== undefined && input.main !== null) {
    objectInput(input.main)
    requireValue(Object.keys(input.main).every(key => ['provider', 'model', 'reasoningEffort'].includes(key)), 'INVALID_CONFIG', '默认主模型配置不正确。')
    const selected = normalizeModelSelection({ ...input.main, kind: 'fixed' })
    if (selected.kind === 'fixed') { const { kind: _kind, ...route } = selected; main = route }
    requireValue(input.models.some(model => model && typeof model === 'object' && !Array.isArray(model) && model.provider === main?.provider && model.model === main?.model), 'INVALID_CONFIG', '默认主模型必须存在于 models 列表。')
  }
  let search: SearchConfig | undefined
  if (input.search !== undefined) {
    objectInput(input.search)
    const value = input.search
    requireValue(Object.keys(value).every(key => ['baseUrl', 'model', 'keyEnv', 'maxUses'].includes(key)) && typeof value.baseUrl === 'string' && URL.canParse(value.baseUrl) && typeof value.model === 'string' && value.model.trim().length > 0 && typeof value.keyEnv === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.keyEnv), 'INVALID_CONFIG', '搜索需要独立的 Anthropic 兼容地址、模型和密钥环境变量。')
    const url = new URL(value.baseUrl)
    requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (value.maxUses === undefined || Number.isInteger(value.maxUses) && Number(value.maxUses) >= 1 && Number(value.maxUses) <= 5), 'INVALID_CONFIG', '搜索地址或调用上限不正确。')
    search = structuredClone(value) as unknown as SearchConfig
  }
  return { models: structuredClone(input.models) as unknown as ModelRegistration[], main, ...(search ? { search } : {}) }
}

async function boundedFile(path: string, max: number) {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    requireValue(info.isFile() && info.size <= max, 'INVALID_CONFIG', '配置文件大小不正确。')
    const buffer = Buffer.alloc(max + 1), { bytesRead } = await handle.read(buffer)
    requireValue(bytesRead <= max, 'INVALID_CONFIG', '配置文件超过大小限制。')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}
