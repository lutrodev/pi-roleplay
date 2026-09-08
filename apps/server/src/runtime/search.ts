import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonObject } from '../../../../packages/rp-core/src/types.ts'

export interface SearchConfig { baseUrl: string; model: string; keyEnv: string; maxUses?: number }
export interface SearchSource { url: string; title?: string; snippet?: string; publishedAt?: string }
export interface SearchResult { sources: SearchSource[]; truncated: boolean }

/** Search uses the Anthropic-format endpoint; it does not inherit the chat-completions URL. */
export class DeepSeekSearch {
  constructor(private readonly config: () => SearchConfig, private readonly dependencies: { fetch?: typeof fetch; env?: (name: string) => string | undefined } = {}) {}

  async search(query: string, maxResults: number, signal: AbortSignal, recordRequest: (request: JsonObject) => void): Promise<SearchResult> {
    signal.throwIfAborted()
    requireValue(typeof query === 'string' && query.trim().length > 0 && query.length <= 2000 && Number.isInteger(maxResults) && maxResults >= 1 && maxResults <= 20,
      'INVALID_SEARCH', '搜索词不能为空或超过 2000 字，每次最多返回 20 条结果。')
    const config = { ...this.config() }
    requireValue(URL.canParse(config.baseUrl), 'SEARCH_NOT_CONFIGURED', '请配置搜索专用的 Anthropic 兼容地址。')
    const base = new URL(config.baseUrl)
    requireValue(['https:', 'http:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
      'SEARCH_NOT_CONFIGURED', '搜索地址不能包含密钥、查询参数或登录信息。')
    requireValue(typeof config.model === 'string' && config.model.trim().length > 0 && /^[A-Z][A-Z0-9_]{0,99}$/.test(config.keyEnv), 'SEARCH_NOT_CONFIGURED', '搜索模型或密钥环境变量未正确配置。')
    const apiKey = (this.dependencies.env ?? (name => process.env[name]))(config.keyEnv)
    requireValue(apiKey && apiKey.trim().length > 0, 'SEARCH_NOT_CONFIGURED', '请在工具设置中配置搜索密钥。')
    const maxUses = config.maxUses ?? 5
    requireValue(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 5, 'SEARCH_NOT_CONFIGURED', '搜索次数上限必须在 1 到 5 之间。')
    const endpoint = base.toString().replace(/\/$/, '') + '/messages'
    const body = { model: config.model, max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query.trim()}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }
    // A journal failure prevents the request from leaving the process.
    recordRequest({ endpoint, apiVersion: '2023-06-01', body })
    const deadline = AbortSignal.timeout(60_000), effective = AbortSignal.any([signal, deadline])
    try {
      const response = await (this.dependencies.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'error', signal: effective,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': apiKey, authorization: 'Bearer ' + apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body),
      })
      if (!response.ok) { await response.body?.cancel(); throw new RpError('SEARCH_PROVIDER_ERROR', `搜索服务返回 HTTP ${response.status}，请检查搜索端点、模型与密钥配置。`, 502) }
      const result = await readJson(response, effective)
      effective.throwIfAborted()
      return mapSearchResults(result, maxResults)
    } catch (error) {
      if (signal.aborted) throw new RpError('SEARCH_CANCELLED', '搜索已取消。')
      if (deadline.aborted) throw new RpError('SEARCH_TIMEOUT', '搜索在 60 秒内未完成。', 504)
      if (error instanceof RpError) throw error
      throw new RpError('SEARCH_PROVIDER_ERROR', '搜索服务连接或响应异常，请检查搜索专用端点。', 502)
    }
  }
}

export function mapSearchResults(response: unknown, maxResults = 5): SearchResult {
  requireValue(isRecord(response) && Array.isArray(response.content), 'SEARCH_PROTOCOL_ERROR', '搜索服务未返回有效的结构化内容。', 502)
  const blocks = response.content.filter(isRecord)
  const native = blocks.filter(block => block.type === 'web_search_tool_result')
  requireValue(native.length > 0, 'SEARCH_NOT_EXECUTED', '提供商未返回搜索结果，不能将模型正文当成网页搜索来源。', 502)
  const snippets = new Map<string, string>()
  for (const block of blocks) if (block.type === 'text' && Array.isArray(block.citations)) {
    for (const citation of block.citations) if (isRecord(citation) && typeof citation.url === 'string' && typeof citation.cited_text === 'string' && !snippets.has(citation.url)) snippets.set(citation.url, citation.cited_text.slice(0, 4000))
  }
  const seen = new Set<string>(), sources: SearchSource[] = []
  for (const block of native) {
    requireValue(Array.isArray(block.content), 'SEARCH_PROVIDER_ERROR', '提供商的搜索工具未成功执行。', 502)
    for (const item of block.content) {
      requireValue(isRecord(item) && item.type === 'web_search_result' && typeof item.url === 'string' && URL.canParse(item.url), 'SEARCH_PROTOCOL_ERROR', '搜索结果格式不正确。', 502)
      const url = new URL(item.url)
      requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'SEARCH_PROTOCOL_ERROR', '搜索结果包含不支持的链接。', 502)
      if (seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({ url: item.url,
        ...(typeof item.title === 'string' && item.title ? { title: item.title.slice(0, 500) } : {}),
        ...(snippets.get(item.url) ? { snippet: snippets.get(item.url)! } : {}),
        ...(typeof item.page_age === 'string' && item.page_age ? { publishedAt: item.page_age.slice(0, 100) } : {}),
      })
    }
  }
  return { sources: sources.slice(0, maxResults), truncated: sources.length > maxResults }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  requireValue(response.body, 'SEARCH_PROTOCOL_ERROR', '搜索服务返回空响应。', 502)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      requireValue(bytes <= 1024 * 1024, 'SEARCH_RESPONSE_TOO_LARGE', '搜索响应超过 1 MB 上限。', 502)
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
