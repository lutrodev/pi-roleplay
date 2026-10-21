import { defaultWriterDelivery, type WriterDelivery } from '../../../../../packages/rp-core/src/agents/writer-delivery.ts'
import { SettingsGroup } from '../../components/settings-layout.tsx'
import { Field, Input, Select, Textarea } from '../../components/ui.tsx'
import { uiT } from '../../lib/i18n.ts'

export function WriterDeliveryFields({ value, enabled, onChange }: {
  value: WriterDelivery | undefined; enabled: boolean; onChange: (value: WriterDelivery) => void
}) {
  const delivery = value ?? { ...defaultWriterDelivery(), mode: 'text' as const }
  const patch = (next: Partial<WriterDelivery>) => onChange({ ...delivery, ...next })
  const required = enabled && delivery.mode !== 'text'
  const terminal = delivery.mode === 'terminal'
  return <SettingsGroup layout="form" title={uiT('本轮正文交付')}>
    <Field label={uiT('交付方式')} help={uiT('与预置历史一起保存并冻结。工具参数正文会自动提取为 Writer 回复，继续经过现有审阅和提交流程。')}>
      <Select value={delivery.mode} onChange={event => patch({ mode: event.target.value as WriterDelivery['mode'] })}>
        <option value="text">{uiT('普通文本')}</option><option value="tool">{uiT('工具参数正文')}</option><option value="terminal">{uiT('终端归档')}</option>
      </Select>
    </Field>
    {delivery.mode !== 'text' && <>
      <p className="muted">{uiT(terminal ? '全部案例、真实历史和本轮输入归档到工具说明。发送的消息重建为：系统声明 → 用户调度 → 助手确认 → 执行请求。' : '本轮资料放入工具说明；消息末尾追加用户调度、助手确认和执行请求。历史中的工具仍不会执行。')}</p>
      <div className="form-grid">
        <Field label={uiT(terminal ? '终端交付工具名前缀' : '正文交付工具名')} help={terminal ? uiT('每次运行添加独立标识，同一运行中的重试沿用该标识。') : undefined}><Input value={delivery.toolName} required={required} maxLength={terminal ? 47 : 64} spellCheck={false} onChange={event => patch({ toolName: event.target.value })} /></Field>
        <Field label={uiT('正文字段名')}><Input value={delivery.fieldName} required={required} maxLength={64} spellCheck={false} onChange={event => patch({ fieldName: event.target.value })} /></Field>
      </div>
      <Field label={uiT('工具说明')} help={uiT('实际发送时会在后面附加本轮冻结的完整写作上下文。')}><Textarea value={delivery.toolDescription} required={required} rows={3} onChange={event => patch({ toolDescription: event.target.value })} /></Field>
      <Field label={uiT('正文字段说明')}><Textarea value={delivery.fieldDescription} required={required} rows={3} onChange={event => patch({ fieldDescription: event.target.value })} /></Field>
      <details className="writer-history-delivery-guide" open={terminal || undefined}><summary>{uiT(terminal ? '终端系统声明与调度链' : '系统补充与调度消息')}</summary><div className="stack">
        <p className="muted">{uiT('支持 %TOOL_NAME%、%OUTPUT_FIELD% 和 %SESSION_ID%，分别表示工具名、输出字段名和会话标识。')}</p>
        <Field label={uiT(terminal ? '终端系统声明' : '系统补充说明')} help={uiT(terminal ? '作为本轮 Writer 系统消息发送；原 Writer 规则保留在工具说明的 writer_rules.txt 中。' : '追加到 Writer 系统提示，留空则不补充。')}><Textarea value={delivery.system} required={required && terminal} rows={4} onChange={event => patch({ system: event.target.value })} /></Field>
        <Field label={uiT('用户调度消息')}><Textarea value={delivery.dispatch} required={required} rows={3} onChange={event => patch({ dispatch: event.target.value })} /></Field>
        <Field label={uiT('预置助手确认')}><Textarea value={delivery.acknowledgement} required={required} rows={3} onChange={event => patch({ acknowledgement: event.target.value })} /></Field>
        <Field label={uiT('本轮执行请求')}><Textarea value={delivery.invocation} required={required} rows={3} onChange={event => patch({ invocation: event.target.value })} /></Field>
      </div></details>
    </>}
  </SettingsGroup>
}
