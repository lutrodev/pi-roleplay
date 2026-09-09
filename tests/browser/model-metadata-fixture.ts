/** Original synthetic metadata. Never forwarded to a live provider. */
export const browserModelMetadata = [
  { id: 'test-model', name: 'Synthetic Text', context_length: 128000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature', 'tools'] },
  { id: 'test-vision-model', name: 'Synthetic Vision', context_length: 200000, top_provider: { max_completion_tokens: 16384 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
  { id: 'test-reasoning-model', name: 'Synthetic Reasoning', context_length: 256000, top_provider: { max_completion_tokens: 32000 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'] },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra · 合成验收', context_length: 200000, top_provider: { max_completion_tokens: 32000 }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] },
  { id: 'gateway/private-alias', name: '网关模型 · 合成验收', supportsImages: true, supportsReasoning: true, contextWindow: 100000, maxTokens: 16000 },
  { id: 'unknown-vision-by-name-only', name: '未提供能力的模型' },
]
