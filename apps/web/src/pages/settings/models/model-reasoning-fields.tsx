import { controlLevels, reasoningLevels, type ReasoningControlConfig, type ReasoningFormat } from '../../../../../../packages/protocol/src/reasoning.ts'
import { reasoningLabel } from '../../../components/reasoning-control.tsx'
import { Field, Input, Select } from '../../../components/ui.tsx'
import { SettingToggle } from '../../../components/settings-controls.tsx'
import type { ModelInfo } from '../../../lib/api.ts'
import { uiT } from '../../../lib/i18n.ts'
import type { ModelFields } from './catalog.ts'

const formatNames: Record<ReasoningFormat, string> = { openai: 'OpenAI · reasoning_effort', 'openai-responses': 'OpenAI Responses · reasoning.effort', deepseek: 'DeepSeek · thinking + reasoning_effort', qwen: 'Qwen · enable_thinking', zai: 'GLM · thinking', openrouter: 'OpenRouter · reasoning', anthropic: 'Anthropic · thinking' }
const modes = { provider: '服务默认', toggle: '开关', effort: '强度档位', budget: '思考预算' }

export function ModelDefaultThinking({ model, patch, auto, loading }: { model: ModelFields; patch: (value: Partial<ModelFields>) => void; auto?: ModelInfo; loading: boolean }) {
  const control = model.reasoningControl ?? auto?.reasoningControl.control ?? { mode: 'provider' }
  const levels = controlLevels(control), selected = model.defaultReasoningEffort ?? 'provider-default'
  const ready = !!model.reasoningControl || !loading
  return <Field layout="row" label={uiT('默认思考')} help={uiT('通常使用服务默认，也可在会话中单独调整。')}>
    {ready && levels.length === 1 && levels.includes(selected) ? <span className="model-default-value">{reasoningLabel(selected)}</span>
      : <Select value={selected} disabled={!ready} onChange={event => patch({ defaultReasoningEffort: event.target.value === 'provider-default' ? undefined : event.target.value })}>
        {!levels.includes(selected) && <option value={selected} disabled>{uiT('当前档位不可用')}</option>}
        {levels.map(level => <option value={level} key={level}>{reasoningLabel(level)}</option>)}
      </Select>}
  </Field>
}

export function ModelReasoningFields({ model, patch, auto }: { model: ModelFields; patch: (value: Partial<ModelFields>) => void; auto?: ModelInfo }) {
  const manual = model.reasoningControl, control = manual ?? auto?.reasoningControl.control ?? { mode: 'provider' }
  const format: ReasoningFormat = control.mode !== 'provider' ? control.format : model.api === 'anthropic-messages' ? 'anthropic' : model.api === 'openai-responses' ? 'openai-responses' : 'openai'
  const availableFormats: ReasoningFormat[] = model.api === 'anthropic-messages' ? ['anthropic'] : model.api === 'openai-responses' ? ['openai-responses'] : ['openai', 'deepseek', 'qwen', 'zai', 'openrouter']
  const levels = controlLevels(control), selectedDefault = model.defaultReasoningEffort ?? 'provider-default'
  const setControl = (next?: ReasoningControlConfig) => patch({ reasoningControl: next,
    ...(next && next.mode !== 'provider' ? { reasoning: true } : {}),
    ...(!controlLevels(next ?? auto?.reasoningControl.control ?? { mode: 'provider' }).includes(selectedDefault) ? { defaultReasoningEffort: undefined } : {}),
  })
  const changeMode = (mode: string) => {
    if (mode === 'auto') { setControl(undefined); return }
    if (mode === 'provider') { setControl({ mode }); return }
    if (mode === 'toggle') { setControl({ mode, format: ['qwen', 'deepseek', 'zai', 'openrouter'].includes(format) ? format as 'qwen' : 'qwen', off: true }); return }
    if (mode === 'budget') { setControl({ mode, format: 'anthropic', levels: { minimal: 1024, low: 2048 }, off: true }); return }
    setControl(control.mode === 'effort' ? structuredClone(control) : { mode: 'effort', format, levels: { low: 'low', medium: 'medium', high: 'high' } })
  }
  return <section className="model-capability-settings" aria-label={uiT('思考控制')}>
    <div className="model-section-heading"><div><h3>{uiT('思考控制')}</h3><p>{uiT('按当前渠道配置；支持思考不代表支持所有档位。')}</p></div></div>
    <Field layout="row" label={uiT('控制方式')} help={manual ? uiT('手动设置 · 请以当前渠道文档为准') : control.mode === 'provider' ? uiT('尚未识别控制方式；不发送思考参数，也不声称已关闭。') : uiT('自动识别 · %{mode}', { mode: uiT(modes[control.mode]) })}>
      <Select value={manual?.mode ?? 'auto'} onChange={event => changeMode(event.target.value)}>
        <option value="auto">{uiT('自动识别')}</option><option value="provider">{uiT('仅使用服务默认')}</option>
        {model.api !== 'anthropic-messages' && model.api !== 'openai-responses' && <option value="toggle">{uiT('开关')}</option>}
        <option value="effort">{uiT('强度档位')}</option>{model.api === 'anthropic-messages' && <option value="budget">{uiT('思考预算（tokens）')}</option>}
      </Select>
    </Field>
    {manual && manual.mode !== 'provider' && <div className="reasoning-adapter-fields stack">
      <Field label={uiT('渠道参数格式')} help={uiT('兼容 OpenAI 的地址也可能使用不同的思考参数。')}><Select value={manual.format} onChange={event => {
        const nextFormat = event.target.value as ReasoningFormat
        if (manual.mode === 'toggle') setControl({ ...manual, format: nextFormat as 'qwen' })
        else if (manual.mode === 'effort') setControl({ ...manual, format: nextFormat, off: undefined })
      }}>{availableFormats.filter(item => manual.mode !== 'toggle' || ['qwen', 'deepseek', 'zai', 'openrouter'].includes(item)).map(item => <option key={item} value={item}>{formatNames[item]}</option>)}</Select></Field>
      {(manual.mode === 'effort' || manual.mode === 'budget') && <fieldset className="reasoning-level-fields"><legend>{uiT(manual.mode === 'budget' ? '支持的档位与思考预算' : '支持的档位与服务参数值')}</legend>
        <p className="field-help">{uiT(manual.mode === 'budget' ? '思考与正文共享输出上限，至少为正文留出 1024 tokens。' : '初始值是编辑模板。只勾选渠道实际支持的档位；相同参数值只保留一档。')}</p>
        {reasoningLevels.map(level => <div className="reasoning-level-field" key={level}>
          <label><input type="checkbox" checked={manual.levels[level] !== undefined} onChange={event => {
            const next = { ...manual.levels }
            if (!event.target.checked) delete next[level]
            else Object.assign(next, { [level]: manual.mode === 'budget' ? { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }[level] : level })
            setControl({ ...manual, levels: next } as ReasoningControlConfig)
          }} />{reasoningLabel(level)}</label>
          {manual.levels[level] !== undefined && <Input aria-label={uiT('%{level}档参数', { level: reasoningLabel(level) })} required type={manual.mode === 'budget' ? 'number' : 'text'} min={manual.mode === 'budget' ? 1024 : undefined} step={1} maxLength={64} value={manual.levels[level]} onChange={event => setControl({ ...manual, levels: { ...manual.levels, [level]: manual.mode === 'budget' ? Number(event.target.value) : event.target.value } } as ReasoningControlConfig)} />}
        </div>)}
      </fieldset>}
      <SettingToggle label={uiT('支持明确关闭思考')} checked={!!manual.off} onChange={event => setControl({ ...manual, off: event.target.checked ? ['openai', 'openai-responses'].includes(manual.format) ? 'none' : true : undefined } as ReasoningControlConfig)} />
      {manual.off && ['openai', 'openai-responses'].includes(manual.format) && <Field label={uiT('关闭时发送的参数值')} help={uiT('例如 none；不填或省略参数不能代表关闭。')}><Input required maxLength={64} value={String(manual.off)} onChange={event => setControl({ ...manual, off: event.target.value } as ReasoningControlConfig)} /></Field>}
    </div>}
    {!manual && control.mode !== 'provider' && <p className="field-help">{uiT('可用选项：%{levels}', { levels: levels.map(reasoningLabel).join(' / ') })}</p>}
  </section>
}
