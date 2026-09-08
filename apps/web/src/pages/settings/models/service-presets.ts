import type { ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'
import type { ModelRegistration } from '../../../../../../apps/server/src/runtime/models.ts'

export interface ServicePreset {
  id: string
  label: string
  description: string
  aliases: string[]
  common?: boolean
  connection: ModelConnection
  docsUrl?: string
  note?: string
  compat?: ModelRegistration['compat']
}

// These are connection defaults, not a model catalog. Models still come from the
// selected service (or an explicit ID); capabilities are never inferred from a name.
const compatible = { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: 'max_tokens' as const }
export const servicePresets: ServicePreset[] = [
  { id: 'openai', label: 'OpenAI', description: 'GPT 系列模型', aliases: ['ChatGPT'], common: true,
    connection: { api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' }, docsUrl: 'https://platform.openai.com/docs/quickstart' },
  { id: 'anthropic', label: 'Anthropic', description: 'Claude 系列模型', aliases: ['Claude', 'Sonnet', 'Opus', 'Haiku'], common: true,
    connection: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }, docsUrl: 'https://platform.claude.com/docs/en/api/overview' },
  { id: 'google', label: 'Google Gemini', description: 'Gemini · Google AI Studio', aliases: ['谷歌'], common: true,
    connection: { api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }, docsUrl: 'https://ai.google.dev/gemini-api/docs/openai', compat: compatible },
  { id: 'openrouter', label: 'OpenRouter', description: '一个连接，使用多家模型', aliases: ['聚合', 'router'], common: true,
    connection: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' }, docsUrl: 'https://openrouter.ai/docs/quickstart' },
  { id: 'moonshot', label: 'Kimi · Moonshot AI', description: 'Kimi 系列模型', aliases: ['月之暗面', 'moonshotai'], common: true,
    connection: { api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1' }, docsUrl: 'https://platform.kimi.com/docs/get-api-key', note: '默认使用国内站 API；其他区域可在自定义设置中修改地址。' },
  { id: 'deepseek', label: 'DeepSeek', description: 'DeepSeek 官方服务', aliases: ['深度求索'], common: true,
    connection: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com' }, docsUrl: 'https://api-docs.deepseek.com/' },
  { id: 'bailian', label: '阿里云百炼', description: 'Qwen 通义千问等模型', aliases: ['Alibaba', 'Aliyun', 'DashScope', 'Qwen', '通义千问'],
    connection: { api: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, docsUrl: 'https://www.alibabacloud.com/help/zh/model-studio/get-api-key', note: '默认使用北京地域的按量 API；其他地域或套餐请按接入文档修改地址。', compat: { ...compatible, thinkingFormat: 'qwen', supportsReasoningEffort: false } },
  { id: 'zhipu', label: '智谱 BigModel', description: 'GLM 系列模型', aliases: ['Zhipu', 'GLM', '智谱清言'],
    connection: { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction', note: '默认使用国内站的按量 API；Coding Plan 请按接入文档修改地址。' },
  { id: 'minimax', label: 'MiniMax', description: 'MiniMax 系列模型 · 国内站', aliases: ['海螺', '稀宇'],
    connection: { api: 'openai-completions', baseUrl: 'https://api.minimaxi.com/v1' }, docsUrl: 'https://platform.minimaxi.com/docs/guides/text-generation', note: '默认使用国内站 API；其他区域可在自定义设置中修改地址。', compat: compatible },
  { id: 'siliconflow', label: '硅基流动', description: 'SiliconFlow · 多家开源模型', aliases: ['SiliconFlow', '硅基'],
    connection: { api: 'openai-completions', baseUrl: 'https://api.siliconflow.cn/v1' }, docsUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart', compat: compatible },
  { id: 'xai', label: 'xAI', description: 'Grok 系列模型', aliases: ['Grok', 'SpaceXAI'],
    connection: { api: 'openai-completions', baseUrl: 'https://api.x.ai/v1' }, docsUrl: 'https://docs.x.ai/developers/quickstart' },
  { id: 'groq', label: 'Groq', description: '开源模型推理服务', aliases: ['Llama', 'Qwen', 'GPT OSS'],
    connection: { api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1' }, docsUrl: 'https://console.groq.com/docs/openai', compat: compatible },
  { id: 'together', label: 'Together AI', description: '开源模型推理服务', aliases: ['Llama', 'Qwen', 'DeepSeek'],
    connection: { api: 'openai-completions', baseUrl: 'https://api.together.ai/v1' }, docsUrl: 'https://docs.together.ai/docs/inference/openai-compatibility' },
  { id: 'fireworks', label: 'Fireworks AI', description: '开源模型推理服务', aliases: ['Llama', 'Qwen', 'Kimi'],
    connection: { api: 'openai-completions', baseUrl: 'https://api.fireworks.ai/inference/v1' }, docsUrl: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility', compat: compatible },
]

export const customService: ServicePreset = { id: 'custom', label: '其他服务', description: '自定义连接 · 兼容接口或本地服务', aliases: [], connection: { api: 'openai-completions', baseUrl: '' } }

export function matchingServices(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return servicePresets.filter(service => {
    const text = [service.id, service.label, service.description, ...service.aliases].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
}

export function serviceForConnection(connection: ModelConnection) {
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '')
  return servicePresets.find(service => service.connection.api === connection.api && service.connection.baseUrl === baseUrl)
}
