import { expect, it } from 'vitest'
import { compactModelLabel } from '../apps/web/src/pages/story/model-label.ts'

it('keeps the model name when a route label includes the service name', () => {
  expect(compactModelLabel({ label: 'DeepSeek V4 Flash · ClinePass', model: 'deepseek/deepseek-v4-flash', provider: 'custom-1' })).toBe('DeepSeek V4 Flash')
  expect(compactModelLabel({ label: 'Sonnet · My Service', model: 'claude-sonnet-4-6', provider: 'my-service' })).toBe('Sonnet')
})

it('preserves labels whose qualifier is needed to identify an otherwise ambiguous model', () => {
  expect(compactModelLabel({ label: 'DeepSeek · V4 Flash', model: 'deepseek-v4-flash', provider: 'custom-1' })).toBe('DeepSeek · V4 Flash')
  expect(compactModelLabel({ label: '角色创作模型', model: 'model', provider: 'service' })).toBe('角色创作模型')
})
