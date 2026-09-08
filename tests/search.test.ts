import { describe, expect, it } from 'vitest'
import { DeepSeekSearch, mapSearchResults } from '../apps/server/src/runtime/search.ts'
import type { JsonObject } from '../packages/rp-core/src/types.ts'

const config = { baseUrl: 'https://api.deepseek.com/anthropic/v1', model: 'deepseek-v4-flash', keyEnv: 'RP_TEST_SEARCH_KEY' }
const native = { content: [
  { type: 'text', text: '模型生成的解释', citations: [{ url: 'https://example.test/a', cited_text: '来源摘录' }] },
  { type: 'web_search_tool_result', content: [
    { type: 'web_search_result', url: 'https://example.test/a', title: '页面 A', page_age: '2026-09-05' },
    { type: 'web_search_result', url: 'https://example.test/a', title: '重复' },
    { type: 'web_search_result', url: 'https://example.test/b', title: '页面 B' },
  ] },
] }

describe('DeepSeek native search', () => {
  it('joins citation snippets, deduplicates sources and applies the requested count', () => {
    expect(mapSearchResults(native, 1)).toEqual({ sources: [{ url: 'https://example.test/a', title: '页面 A', publishedAt: '2026-09-05', snippet: '来源摘录' }], truncated: true })
    expect(mapSearchResults({ content: [{ type: 'web_search_tool_result', content: [] }] })).toEqual({ sources: [], truncated: false })
  })

  it('never treats prose or a failed server tool as successful search', () => {
    expect(() => mapSearchResults({ content: [{ type: 'text', text: 'Here are some invented websites.' }] })).toThrow('不能将模型正文')
    expect(() => mapSearchResults({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }] })).toThrow('未成功执行')
    expect(() => mapSearchResults({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'javascript:alert(1)' }] }] })).toThrow('不支持的链接')
  })

  it('records the exact non-secret body before using the separate search endpoint', async () => {
    const records: JsonObject[] = []
    let calls = 0
    const search = new DeepSeekSearch(() => config, { env: () => 'synthetic-search-key', fetch: async (url, init) => {
      expect(records).toHaveLength(1); calls += 1
      expect(String(url)).toBe('https://api.deepseek.com/anthropic/v1/messages')
      expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-search-key')
      expect(JSON.parse(String(init?.body))).toEqual(records[0]?.body)
      expect(init?.redirect).toBe('error')
      return Response.json(native)
    } })
    expect((await search.search('灯塔史料', 5, new AbortController().signal, request => records.push(request))).sources).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain('synthetic-search-key')
    expect(calls).toBe(1)
  })

  it('does not dispatch without a key or when recording the request fails', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return Response.json(native) }
    await expect(new DeepSeekSearch(() => config, { env: () => undefined, fetch: fetcher }).search('query', 5, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' })
    await expect(new DeepSeekSearch(() => config, { env: () => 'key', fetch: fetcher }).search('query', 5, new AbortController().signal, () => { throw new Error('journal unavailable') })).rejects.toThrow('journal unavailable')
    expect(calls).toBe(0)
  })

  it('propagates cancellation to the HTTP request without retrying', async () => {
    const controller = new AbortController()
    let calls = 0
    const search = new DeepSeekSearch(() => config, { env: () => 'key', fetch: async (_url, init) => {
      calls += 1
      return await new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); controller.abort() })
    } })
    await expect(search.search('query', 5, controller.signal, () => {})).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' })
    expect(calls).toBe(1)
  })
})
