import { uiT, useUiLanguage } from "../../lib/i18n.ts"
import type { StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import { Sparkles, ChevronDown } from 'lucide-react'
import { ChoiceOption } from '../../components/choice-option.tsx'
import { StatusNotice } from '../../components/status-notice.tsx'

export function ReplySuggestions({ story, preferences, busy, insert }: { story: StorySnapshot; preferences: Preferences; busy: boolean; insert: (text: string) => void }) {
  useUiLanguage()
  const last = story.messages.filter(message => message.kind !== 'tool').at(-1)
  const options = last ? story.replyOptions[last.id] ?? [] : [], maintenance = story.maintenance['reply-options']
  if (!preferences.replyOptionsEnabled || story.archived || busy) return null
  return <>
    {options.length > 0 && <details key={last?.id} className="reply-suggestions" open>
      <summary><Sparkles size={14} /><span className="suggestions-title">{uiT('回复建议')}</span><span className="suggestions-hint">{uiT('选一条填入输入框')}</span><ChevronDown className="suggestions-chevron" size={14} /></summary>
      <div className="reply-options choice-list" aria-label={uiT('回复建议')}>{options.map((option, index) => <ChoiceOption key={option} kind="action" number={index + 1} label={option} onClick={event => {
        insert(option)
        const details = event.currentTarget.closest('details')
        if (details) details.open = false
      }} />)}</div>
    </details>}
    {last && maintenance?.status === 'failed' && maintenance.messageId === last.id && <StatusNotice className="reply-suggestions-failure" compact icon={Sparkles} title={options.length ? uiT('回复建议未更新') : uiT('回复建议暂不可用')} details={maintenance.message ? uiT(maintenance.message) : undefined}><p>{options.length ? uiT('仍可使用已有建议，或直接输入。') : uiT('可以直接输入，继续对话。')}</p></StatusNotice>}
  </>
}
