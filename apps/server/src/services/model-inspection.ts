import type { ModelRegistration } from '../runtime/models.ts'
import { ModelRegistry } from '../runtime/models.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'

export interface ModelConnection { api?: ModelRegistration['api']; baseUrl: string }
export interface DiscoveredModel { model: string; label: string }
export interface ModelCheck { status: 'passed' | 'failed'; checkedAt: string; durationMs: number; code?: string; message: string }

export function validateConnection(value: unknown): ModelConnection {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'MODEL_CONFIG_INVALID', '请填写连接协议和地址。')
  const connection = value as Record<string, unknown>
  requireValue(Object.keys(connection).every(key => ['api', 'baseUrl'].includes(key)) && (connection.api === undefined || ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(String(connection.api))), 'MODEL_CONFIG_INVALID', '请选择支持的 API 协议。')
  let url: URL | undefined
  try { url = new URL(String(connection.baseUrl)) } catch { /* Report the authored validation below. */ }
  requireValue(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.href.length <= 2000, 'MODEL_CONFIG_INVALID', '模型地址必须为 HTTP(S) 地址，不能携带凭据或查询参数。')
  requireValue(!/\/(chat\/completions|responses|messages|models)\/?$/.test(url.pathname), 'MODEL_CONFIG_INVALID', '请填写 API 基础地址，不包含 /chat/completions、/responses、/messages 或 /models。')
  return { ...(connection.api ? { api: connection.api as ModelRegistration['api'] } : {}), baseUrl: url.href.replace(/\/$/, '') }
}

/** Keep provider response bodies, endpoints and credentials out of errors returned to the browser. */
export function inspectionError(error: unknown): RpError {
  if (error instanceof RpError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/abort|timeout|timed out/i.test(message)) return new RpError('MODEL_TEST_TIMEOUT', '请求超时，请检查地址或稍后重试。', 504)
  if (/\b(401|403)\b|authentication|unauthorized|invalid.*(key|token)|permission denied/i.test(message)) return new RpError('MODEL_AUTH_FAILED', '服务拒绝了密钥或访问权限，请检查密钥和账户权限。', 422)
  if (/\b404\b|model.*not found|not_found_error|does not exist/i.test(message)) return new RpError('MODEL_ENDPOINT_NOT_FOUND', '未找到接口或模型，请检查基础地址和模型 ID。', 422)
  if (/\b429\b|rate.?limit|quota|insufficient.*credit/i.test(message)) return new RpError('MODEL_RATE_LIMITED', '服务额度不足或请求过于频繁，请检查账户后重试。', 422)
  return new RpError('MODEL_CONNECTION_FAILED', '未能完成模型请求，请检查连接、协议及模型参数后重试。', 422)
}

async function responseJson(response: Response) {
  if (!response.ok) throw inspectionError(new Error(String(response.status)))
  const reader = response.body?.getReader()
  requireValue(reader, 'MODEL_LIST_INVALID', '服务未返回模型列表；可以手动填写模型 ID。', 422)
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.byteLength
      requireValue(size <= 5 * 1024 * 1024, 'MODEL_LIST_TOO_LARGE', '模型列表超过读取上限，请手动填写需要的模型 ID。', 422)
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  catch { throw new RpError('MODEL_LIST_INVALID', '服务未返回有效的模型列表；可以手动填写模型 ID。', 422) }
}

/** Discovery lists identifiers only; receiving a list does not prove a model can generate. */
export async function discoverModels(connection: ModelConnection, apiKey: string, fetcher: typeof fetch, signal: AbortSignal) {
  requireValue(connection.api, 'MODEL_CONFIG_INVALID', '获取模型列表前请选择 API 协议。')
  const anthropic = connection.api === 'anthropic-messages'
  const url = new URL(connection.baseUrl + (anthropic && !connection.baseUrl.endsWith('/v1') ? '/v1/models' : '/models'))
  if (anthropic) url.searchParams.set('limit', '1000')
  const headers: Record<string, string> = anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` }
  const found = new Map<string, DiscoveredModel>(), cursors = new Set<string>()
  let truncated = false
  for (let page = 0; page < 10; page++) {
    const body = await responseJson(await fetcher(url, { method: 'GET', headers, signal, redirect: 'error' }))
    requireValue(Array.isArray(body.data), 'MODEL_LIST_INVALID', '服务返回的内容不是模型列表；可以手动填写模型 ID。', 422)
    for (const item of body.data as unknown[]) {
      if (!item || typeof item !== 'object') continue
      const value = item as Record<string, unknown>, id = value.id
      if (typeof id !== 'string' || !id.trim() || id.length > 200) continue
      const name = value.display_name ?? value.name
      found.set(id, { model: id, label: typeof name === 'string' && name.trim() ? name.slice(0, 200) : id })
      if (found.size >= 10000) { truncated = true; break }
    }
    if (truncated || body.has_more !== true) break
    const cursor = body.last_id
    requireValue(typeof cursor === 'string' && cursor.length <= 500 && !cursors.has(cursor), 'MODEL_LIST_INVALID', '服务返回了无效的分页信息，请手动填写模型 ID。', 422)
    cursors.add(cursor); url.searchParams.set('after_id', cursor)
    if (page === 9) truncated = true
  }
  return { models: [...found.values()], truncated }
}

/** Run the same Pi protocol adapter as conversations, without tools or story persistence. */
export async function checkModel(registration: ModelRegistration, apiKey: string, options: ConstructorParameters<typeof ModelRegistry>[1], signal: AbortSignal): Promise<ModelCheck> {
  const start = Date.now()
  try {
    const registry = new ModelRegistry([registration], { ...options, env: () => apiKey })
    const { model, thinkingLevel } = registry.resolve({ provider: registration.provider, model: registration.model })
    const result = await registry.stream(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: start }] }, {
      signal, maxRetries: 0, timeoutMs: 15000, reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel,
      maxTokens: Math.min(thinkingLevel === 'off' ? 32 : 1024, model.maxTokens),
    }).result()
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage || result.stopReason)
    return { status: 'passed', checkedAt: new Date().toISOString(), durationMs: Date.now() - start, message: '模型调用成功。' }
  } catch (error) {
    const failure = inspectionError(error)
    return { status: 'failed', checkedAt: new Date().toISOString(), durationMs: Date.now() - start, code: failure.code, message: failure.message }
  }
}
