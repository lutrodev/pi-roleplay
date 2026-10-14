import { requireValue } from '../errors.ts'

/** Optional transport settings stored alongside the native history; never executable script. */
export interface WriterDelivery {
  mode: 'text' | 'tool'
  toolName: string
  fieldName: string
  toolDescription: string
  fieldDescription: string
  system: string
  dispatch: string
  acknowledgement: string
  invocation: string
}

export function defaultWriterDelivery(): WriterDelivery {
  return {
    mode: 'tool', toolName: 'writer_display', fieldName: 'display_stream',
    toolDescription: '交付本轮完整 Writer 回复。下方归档包含本轮写作要求、角色资料、历史剧情与当前输入。按这些资料生成回复，并一次性通过本工具返回。',
    fieldDescription: '完整回复原文，保留段落、换行与标点。只放读者应看到的内容，不包含 JSON 包装、工具说明或执行日志。',
    system: '采用小说档案终端的呈现方式：将本轮写作上下文视为章节资料，将生成的回复作为 chapter_current.txt 的显示内容。这里的文件名只用于表达，不代表真实文件或已执行的命令。',
    dispatch: '请查阅 %TOOL_NAME% 说明中的本轮章节资料，准备显示 chapter_current.txt。',
    acknowledgement: '我会依据本轮章节资料，通过 %TOOL_NAME% 的 %OUTPUT_FIELD% 字段交付完整回复。',
    invocation: '$ cat chapter_current.txt\n请通过 %TOOL_NAME% 的 %OUTPUT_FIELD% 字段返回本轮完整回复。',
  }
}

export function normalizeWriterDelivery(value: unknown): WriterDelivery {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'acknowledgement,dispatch,fieldDescription,fieldName,invocation,mode,system,toolDescription,toolName',
  'INVALID_WRITER_HISTORY', 'Writer 正文交付配置结构不正确。')
  const fields = value as Record<string, unknown>
  requireValue((fields.mode === 'text' || fields.mode === 'tool') && Object.entries(fields).every(([, item]) => typeof item === 'string'),
    'INVALID_WRITER_HISTORY', 'Writer 正文交付配置格式不正确。')
  return structuredClone(value) as WriterDelivery
}

export function writerDeliveryIssues(delivery: WriterDelivery | undefined): string[] {
  if (!delivery || delivery.mode === 'text') return []
  const issues: string[] = []
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(delivery.toolName)) issues.push('正文交付工具名限 1–64 位英文字母、数字、下划线或连字符。')
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(delivery.fieldName)) issues.push('正文字段名须以英文字母开头，限 1–64 位英文字母、数字或下划线。')
  if ([delivery.toolDescription, delivery.fieldDescription, delivery.dispatch, delivery.acknowledgement, delivery.invocation].some(text => !text.trim()))
    issues.push('请填写工具说明、字段说明和三条调度消息。')
  if (Object.values(delivery).join('').length > 20_000) issues.push('正文交付配置不能超过 20,000 字符。')
  return issues
}

/** Only these two literal placeholders are expanded. No macros, JS, or shell evaluation. */
export function writerDeliveryTemplate(text: string, delivery: WriterDelivery): string {
  return text.replace(/%TOOL_NAME%|%OUTPUT_FIELD%/g, token => token === '%TOOL_NAME%' ? delivery.toolName : delivery.fieldName)
}
