import { afterEach, expect, it } from 'vitest'
import { blankWriterHistory, compileWriterHistory, normalizeWriterHistory, writerHistoryIssues, writerHistoryPreview, WRITER_HISTORY_LIMITS } from '../packages/rp-core/src/agents/writer-history.ts'
import { WriterHistoryService } from '../apps/server/src/services/writer-history-service.ts'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { fixture } from './helpers.ts'
import { historyConfig } from './writer-history-fixture.ts'
import { exampleWriterHistory, writerHistoryEditorDraft } from '../packages/rp-core/src/agents/writer-history-example.ts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(close => close()))
function setup() { const x = fixture(); cleanup.push(x.close); return { ...x, service: new WriterHistoryService(x.assets) } }

it('initializes an example disabled, permits unfinished drafts, rejects enabling until valid', () => {
  const x = setup(), initial = x.service.snapshot()
  expect(initial).toEqual({ version: 1, revision: 1, config: exampleWriterHistory() })
  expect(x.service.capture()).toBeUndefined()
  initial.config = blankWriterHistory()
  initial.config.rounds[0]!.steps = []
  initial.config.rounds[1]!.steps[0]!.argumentsJson = '{draft'
  x.service.update(1, initial.config)
  expect(x.service.snapshot().revision).toBe(2)
  expect(() => x.service.update(2, { ...initial.config, enabled: true })).toThrow('用户消息不能为空')
  expect(x.service.snapshot().revision).toBe(2)
})

it('uses reference-reading tools while leaving the topic and final assistant writing blank', () => {
  const config = exampleWriterHistory(), x = setup()
  expect(config.enabled).toBe(false)
  expect(config.rounds.map(round => round.steps.length)).toEqual([1, 1])
  for (const [index, round] of config.rounds.entries()) {
    expect(round.user).toMatch(/题材：\n$/)
    expect(round.assistant).toBe('')
    expect(round.steps[0]!.name).toBe('read')
    expect(JSON.parse(round.steps[0]!.argumentsJson)).toEqual({ file_path: ['writing-requirements.md', 'style-notes.md'][index] })
    expect(JSON.parse(round.steps[0]!.resultJson)).toMatchObject({ text: expect.any(String), startLine: 1, truncated: false })
  }
  expect(writerHistoryIssues(config)).toEqual(['第 1 轮：助手最终回复不能为空。', '第 2 轮：助手最终回复不能为空。'])
  const custom = structuredClone(config)
  custom.enabled = true
  custom.rounds[0]!.user = '运行自定义工具并说明结果。'
  custom.rounds[0]!.steps = [{ name: 'custom_action_27', argumentsJson: '{"arbitrary":[1,true,"custom"]}', resultJson: '{"result":{"accepted":true}}', isError: false }]
  custom.rounds[0]!.assistant = '自定义操作结果已记录。'
  custom.rounds[1]!.assistant = '另一轮的自定义助手回复。'
  expect(normalizeWriterHistory(custom)).toEqual(custom)
  x.service.update(1, custom)
  const captured = x.service.capture()!
  expect(captured.metadata).toMatchObject({ revision: 2, messageCount: 8, toolCallCount: 2 })
  expect(captured.messages[1]!.content[0]).toMatchObject({ type: 'toolCall', name: 'custom_action_27', argumentsJson: custom.rounds[0]!.steps[0]!.argumentsJson })
  expect(captured.messages[2]!.content[0]).toEqual({ type: 'text', text: custom.rounds[0]!.steps[0]!.resultJson })
  custom.rounds[1]!.assistant = '  '
  expect(() => x.service.update(2, custom)).toThrow('助手最终回复不能为空')
  const original = config.rounds[0]!.user
  config.rounds[0]!.user = 'edited'
  expect(exampleWriterHistory().rounds[0]!.user).toBe(original)
})

it('preserves existing tool histories and saved drafts when initialized again', () => {
  const x = setup(), existing = { version: 1 as const, revision: 1, config: historyConfig() }
  x.assets.setSetting('writer.history', JSON.parse(JSON.stringify(existing)))
  expect(new WriterHistoryService(x.assets).snapshot()).toEqual(existing)
  const savedBlank = x.service.update(1, blankWriterHistory())
  expect(new WriterHistoryService(x.assets).snapshot()).toEqual(savedBlank)
  const edited = blankWriterHistory(); edited.rounds[0]!.user = '用户保留的草稿'
  const saved = x.service.update(2, edited)
  expect(new WriterHistoryService(x.assets).snapshot()).toEqual(saved)
})

it('prefills only the untouched initial blank editor while preserving saved drafts', () => {
  const untouched = { version: 1 as const, revision: 1, config: blankWriterHistory() }
  expect(writerHistoryEditorDraft(untouched)).toEqual(exampleWriterHistory())
  expect(untouched.config).toEqual(blankWriterHistory())
  expect(writerHistoryEditorDraft({ ...untouched, revision: 2 })).toEqual(blankWriterHistory())
  untouched.config.rounds[0]!.user = '自定义用户消息'
  const draft = writerHistoryEditorDraft(untouched)
  expect(draft).toEqual(untouched.config)
  draft.rounds[0]!.user = '只修改编辑副本'
  expect(untouched.config.rounds[0]!.user).toBe('自定义用户消息')
})

it('compiles serial, paired calls, preserves JSON lexemes, and never permits editable IDs', () => {
  const config = normalizeWriterHistory(historyConfig()), messages = compileWriterHistory(config)
  expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'toolResult', 'assistant', 'user', 'assistant', 'toolResult', 'assistant'])
  expect(messages[2]).toMatchObject({ toolCallId: 'wh_r1_s1', isError: true })
  expect(messages[4]).toMatchObject({ toolCallId: 'wh_r1_s2', isError: false })
  expect(messages[8]).toMatchObject({ toolCallId: 'wh_r2_s1', isError: false })
  expect(writerHistoryPreview(messages)).toContain('900719925474099312345')
  expect(writerHistoryPreview(messages)).toContain('1.000000000000000001')
  expect(writerHistoryPreview(messages)).toContain('1e400')
  expect(() => normalizeWriterHistory({ ...config, id: 'editable' })).toThrow('结构')
  config.rounds[0]!.steps.reverse()
  expect(compileWriterHistory(config)[2]).toMatchObject({ toolCallId: 'wh_r1_s1', isError: false })
  config.rounds[0]!.steps.splice(0, 1)
  expect(compileWriterHistory(config)).toHaveLength(8)
})

it.each(['a.b', '工具', 'has space', 'x'.repeat(65), ''])('rejects invalid native tool name %s before any model call', name => {
  const config = historyConfig(); config.rounds[0]!.steps[0]!.name = name
  expect(() => normalizeWriterHistory(config)).toThrow('工具名')
})

it.each(['[]', 'null', 'true', '42', '"text"', '{bad'])('rejects non-object or malformed JSON %s in both fields', source => {
  for (const key of ['argumentsJson', 'resultJson'] as const) {
    const config = historyConfig(); config.rounds[1]!.steps[0]![key] = source
    expect(() => normalizeWriterHistory(config)).toThrow('对象型 JSON')
  }
})

it('enforces two rounds, 16 steps, exact compiled character boundary, and UTF-8 storage limit even for drafts', () => {
  const config = historyConfig()
  expect(() => normalizeWriterHistory({ ...config, rounds: [config.rounds[0]] })).toThrow('两轮')
  config.rounds[0]!.steps = Array.from({ length: 16 }, () => ({ ...config.rounds[1]!.steps[0]! }))
  expect(writerHistoryIssues(config)).toEqual([])
  config.rounds[0]!.steps.push({ ...config.rounds[1]!.steps[0]! })
  expect(() => normalizeWriterHistory(config)).toThrow('16')
  const sized = historyConfig(), length = writerHistoryPreview(compileWriterHistory(sized)).length
  sized.rounds[0]!.user += 'x'.repeat(WRITER_HISTORY_LIMITS.characters - length)
  expect(normalizeWriterHistory(sized)).toEqual(sized)
  sized.rounds[0]!.user += 'x'
  expect(() => normalizeWriterHistory(sized)).toThrow('20,000')
  sized.enabled = false
  expect(normalizeWriterHistory(sized)).toEqual(sized)
  sized.rounds[0]!.user = '文'.repeat(90_000)
  expect(() => normalizeWriterHistory(sized)).toThrow('262,144')
})

it('atomically rejects revision conflicts, freezes independent snapshots, survives database restart and fails visibly on corruption', () => {
  const x = setup(); x.service.update(1, historyConfig())
  const captured = x.service.capture()!, original = JSON.stringify(captured)
  const next = historyConfig(); next.rounds[0]!.user = '新的预置消息'
  x.service.update(2, next)
  expect(() => x.service.update(2, historyConfig())).toThrow('已被更新')
  expect(JSON.stringify(captured)).toBe(original)
  expect(captured.metadata).toMatchObject({ revision: 2, messageCount: 10, toolCallCount: 3, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(x.service.capture()!.metadata.digest).not.toBe(captured.metadata.digest)
  x.database.close()
  const restored = new AppDatabase(x.filename)
  try {
    const assets = new AssetRepository(restored), service = new WriterHistoryService(assets)
    expect(service.snapshot()).toMatchObject({ revision: 3, config: next })
    assets.setSetting('writer.history', { version: 999, revision: 3, config: {} })
    expect(() => service.capture()).toThrow('无法读取')
    expect(() => new WriterHistoryService(assets).snapshot()).toThrow('无法读取')
    expect(assets.getSetting('writer.history')).toEqual({ version: 999, revision: 3, config: {} })
  } finally { restored.close() }
})
