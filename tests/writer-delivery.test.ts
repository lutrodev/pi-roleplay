import { afterEach, expect, it } from 'vitest'
import { toolHistoryConfig } from './writer-history-fixture.ts'
import { compileWriterHistory, normalizeWriterHistory, writerHistoryIssues } from '../packages/rp-core/src/agents/writer-history.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { fixture } from './helpers.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))

it('provides an editable, disabled example with a native dispatch/acknowledgement prefix', () => {
  const config = toolHistoryConfig()
  expect(config.enabled).toBe(false)
  expect(writerHistoryIssues(config)).toEqual([])
  const messages = compileWriterHistory(config)
  expect(messages).toHaveLength(10)
  expect(messages.slice(-2)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '请查阅 writer_display 说明中的本轮章节资料，准备显示 chapter_current.txt。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '我会依据本轮章节资料，通过 writer_display 的 display_stream 字段交付完整回复。' }] },
  ])
  config.delivery!.toolName = 'custom_output'
  config.delivery!.fieldName = 'reply_text'
  expect(JSON.stringify(compileWriterHistory(config).slice(-2))).toContain('custom_output 的 reply_text')
  expect(toolHistoryConfig().delivery!.toolName).toBe('writer_display')
})

it.each([
  ['toolName', 'read.file'], ['fieldName', '__proto__'], ['fieldName', 'has space'], ['dispatch', ' '],
  ['acknowledgement', ''], ['invocation', ''], ['toolDescription', ''], ['fieldDescription', ''], ['system', 'x'.repeat(20_001)],
] as const)('validates enabled delivery settings (%s) and preserves incomplete disabled drafts', (field, text) => {
  const config = toolHistoryConfig(); config.delivery![field] = text
  expect(normalizeWriterHistory(config)).toEqual(config)
  expect(() => normalizeWriterHistory({ ...config, enabled: true })).toThrow()
})

it('rejects unknown or mistyped delivery structures even when injection is disabled', () => {
  const config = toolHistoryConfig()
  for (const delivery of [null, {}, { ...config.delivery, mode: 'script' }, { ...config.delivery, invocation: 42 }, { ...config.delivery, javascript: 'anything' }])
    expect(() => normalizeWriterHistory({ ...config, delivery })).toThrow('配置')
})

it('continues counting generic delivery guides toward the existing history size limit', () => {
  const config = toolHistoryConfig()
  config.rounds[0]!.user = 'x'.repeat(15_000)
  config.delivery!.dispatch = 'd'.repeat(6000)
  expect(writerHistoryIssues(config)).toContain('编译后的 Writer 预置历史不能超过 20,000 字符。')
  config.delivery!.dispatch = 'dispatch'
  expect(writerHistoryIssues(config)).toEqual([])
})

it('freezes delivery settings, includes them in the digest, and restores them from the same SQLite record', () => {
  const x = fixture(); cleanup.push(x.close)
  const service = new WriterHistoryService(x.assets), config = toolHistoryConfig(); config.enabled = true
  service.update(1, config)
  const first = service.capture()!
  config.delivery!.fieldDescription = '下轮使用的新字段说明'
  service.update(2, config)
  const second = service.capture()!
  expect(first.messages).toEqual(second.messages)
  expect(first.metadata.digest).not.toBe(second.metadata.digest)
  expect(first.delivery!.fieldDescription).not.toContain('下轮')
  expect(first.metadata).toMatchObject({ revision: 2, messageCount: 10, toolCallCount: 2 })
  x.database.close()
  const database = new AppDatabase(x.filename)
  try {
    const restored = new WriterHistoryService(new AssetRepository(database))
    expect(restored.capture()).toEqual(second)
    restored.update(3, { ...config, enabled: false })
    expect(restored.capture()).toBeUndefined()
    expect(restored.snapshot().config.delivery).toEqual(config.delivery)
  } finally { database.close() }
})

it('selecting plain text retains the delivery draft but removes the dispatch chain and live tool', () => {
  const x = fixture(); cleanup.push(x.close)
  const service = new WriterHistoryService(x.assets), config = toolHistoryConfig()
  config.enabled = true; config.delivery!.mode = 'text'; config.delivery!.toolName = ''
  service.update(1, config)
  expect(service.capture()!.messages).toHaveLength(8)
  expect(service.capture()!.delivery).toBeUndefined()
  expect(service.snapshot().config.delivery!.mode).toBe('text')
})
