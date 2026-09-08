import { describe, expect, it } from 'vitest'
import { ModelRegistry, type ModelRegistration } from '../apps/server/src/runtime/models.ts'
import { profile } from './helpers.ts'
import { normalizeProfile } from '../packages/rp-core/src/story/profile.js'
import type { StoryProfile } from '../packages/rp-core/src/types.ts'

const custom: ModelRegistration = { provider: 'test-provider', model: 'test-model', keyEnv: 'TEST_MODEL_KEY',
  api: 'openai-completions', baseUrl: 'https://model.test/v1', contextWindow: 32_000, maxTokens: 8000, outputTokens: 1234 }
const route = { provider: custom.provider, model: custom.model }

describe('Pi model adapter and route validation', () => {
  it('calls the real Pi OpenAI adapter with server credentials and parses streamed deltas', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const registry = new ModelRegistry([custom], { env: () => 'private-test-key', fetch: async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return new Response([
        'data: ' + JSON.stringify({ id: 'test-completion', choices: [{ index: 0, delta: { role: 'assistant', content: '海风' }, finish_reason: null }] }),
        'data: ' + JSON.stringify({ id: 'test-completion', choices: [{ index: 0, delta: { content: '吹过。' }, finish_reason: 'stop' }] }),
        'data: [DONE]', '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    } })
    const { model } = registry.resolve(route)
    const result = await registry.stream(model, { systemPrompt: '写故事', messages: [{ role: 'user', content: '继续', timestamp: 0 }] }).result()
    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: '海风吹过。' })])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://model.test/v1/chat/completions')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer private-test-key')
    expect(requests[0]?.body).toMatchObject({ model: 'test-model', stream: true, max_completion_tokens: 1234 })
    expect(JSON.stringify(registry.list())).not.toContain('private-test-key')
    expect(JSON.stringify(registry.list())).not.toContain('TEST_MODEL_KEY')
  })

  it('rejects absent credentials, unsupported images and reasoning instead of silently dropping them', () => {
    expect(() => new ModelRegistry([custom]).resolve(route)).toThrow('密钥')
    const registry = new ModelRegistry([custom], { env: () => 'configured' })
    expect(() => registry.resolve(route, [{ type: 'image', mimeType: 'image/png', data: 'AA==' }])).toThrow('不支持图片')
    expect(() => registry.resolve({ ...route, reasoningEffort: 'high' })).toThrow('思考强度')
    expect(() => registry.resolve({ ...route, model: 'unknown' })).toThrow('尚未在服务端配置')
  })

  it('uses explicit Writer overrides while inherited routes follow the current main model', () => {
    const registry = new ModelRegistry([custom, { ...custom, model: 'writer-model' }], { env: () => 'configured' })
    const config = profile()
    expect(registry.routes(config, { main: route })).toEqual({ main: route, writer: route })
    config.runtime.writerRoute = { kind: 'fixed', provider: custom.provider, model: 'writer-model' }
    expect(registry.routes(config, { main: route }).writer.model).toBe('writer-model')
    config.runtime.writerRoute = { kind: 'inherit' }
    expect(registry.routes(config, { main: route, writer: { ...route, model: 'writer-model' } }).writer).toEqual(route)
    delete config.runtime.writerRoute
    expect(registry.routes(config, { main: route, writer: { ...route, model: 'writer-model' } }).writer.model).toBe('writer-model')
  })

  it('preserves per-story reasoning for selected and inherited main models and rejects unsupported effort', () => {
    const registry = new ModelRegistry([{ ...custom, reasoning: true }], { env: () => 'configured' })
    const config = normalizeProfile({ ...profile(), runtime: { executionMode: 'agent', reasoningEffort: 'high' } }, 0) as StoryProfile
    expect(registry.routes(config, { main: route }).main).toEqual({ ...route, reasoningEffort: 'high' })
    config.runtime = { ...config.runtime, ...route, reasoningEffort: 'low' }
    expect(registry.routes(config, { main: route }).writer.reasoningEffort).toBe('low')
    config.runtime.reasoningEffort = 'unsupported'
    expect(() => registry.routes(config, { main: route })).toThrow('思考强度')
    expect(() => normalizeProfile({ ...profile(), runtime: { reasoningEffort: 3 } }, 0)).toThrow('reasoningEffort')
  })

  it('requires complete custom model capabilities and keeps secrets out of endpoint URLs', () => {
    expect(() => new ModelRegistry([{ provider: 'test', model: 'unknown', keyEnv: 'KEY' }])).toThrow('上下文窗口')
    expect(() => new ModelRegistry([{ ...custom, baseUrl: 'https://user:secret@model.test' }])).toThrow('凭据')
    expect(() => new ModelRegistry([{ ...custom, outputTokens: 50_000 }])).toThrow('输出上限')
    expect(() => new ModelRegistry([custom, custom])).toThrow('重复配置')
  })
})
