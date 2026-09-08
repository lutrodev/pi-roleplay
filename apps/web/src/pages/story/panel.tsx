import { uiT, useUiLanguage } from '../../lib/i18n.ts'
import { Activity, ChevronDown, Ellipsis, FileText, SlidersHorizontal } from 'lucide-react'
import type { Preferences } from '../../../../../packages/rp-core/src/settings/preferences.ts'
import type { RunRecord, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import type { useDialogGuard } from '../../components/form-guard.tsx'
import { Button, Menu, MenuItem } from '../../components/ui.tsx'
import { ContextPanel } from './context-panel.tsx'
import { FilesPanel } from './files-panel.tsx'
import { SummaryPanel } from './summary-panel.tsx'
import { StoryWiki } from './wiki.tsx'
import { StoryLogs } from './logs.tsx'
import { InspectorSurface } from './inspector-surface.tsx'
import { ConversationHistory } from './rounds.tsx'
import { VariablesPanel } from './variables.tsx'
import { ReadingPanel } from './reading-panel.tsx'

export type StoryPanelTab = 'wiki' | 'state' | 'summary' | 'files' | 'context' | 'logs' | 'history' | 'reading'
export type StoryPanelTarget = { tab: StoryPanelTab }
const titles = { wiki: '会话资料', state: '变量', summary: '会话总结', files: '会话文件', context: '上下文', logs: '日志', history: '对话记录', reading: '阅读与显示' }

export function StoryPanel({ target, choose, close, story, latestReplyId, runs, preferences, guard, onJump, historyBusy, onTrace }: {
  onTrace: () => void; target: StoryPanelTarget | null; choose: (target: StoryPanelTarget) => void; close: () => void; story: StorySnapshot; latestReplyId: string | null; runs: RunRecord[]; preferences: Preferences; guard: ReturnType<typeof useDialogGuard>; onJump: (id: string) => void; historyBusy: boolean
}) {
  useUiLanguage()
  const tab = target?.tab, materials = tab && ['wiki', 'state', 'summary', 'files', 'context', 'logs'].includes(tab)
  return <InspectorSurface open={!!target} title={uiT(tab ? titles[tab] : '会话资料')} close={close} guard={guard} viewKey={`${story.id}-${tab}`} navigation={materials && <nav className="inspector-navigation" aria-label={uiT('会话资料分类')}>
      <Button tone="quiet" aria-pressed={tab === 'wiki'} onClick={() => choose({ tab: 'wiki' })}>{uiT('资料')}</Button>
      <Button tone="quiet" aria-pressed={tab === 'state'} onClick={() => choose({ tab: 'state' })}>{uiT('变量')}</Button>
      <Button tone="quiet" aria-pressed={tab === 'summary'} onClick={() => choose({ tab: 'summary' })}>{uiT('总结')}</Button>
      <Button tone="quiet" aria-pressed={tab === 'files'} onClick={() => choose({ tab: 'files' })}>{uiT('文件')}</Button>
      <Menu label={uiT('运行信息')} trigger={<Button tone="quiet" className="inspector-secondary-nav" aria-label={uiT('运行信息')} title={uiT('运行信息')} aria-pressed={['context', 'logs'].includes(tab!)}><span className="inspector-nav-label">{uiT('运行信息')}</span><ChevronDown className="inspector-more-chevron" size={13} /><Ellipsis className="inspector-more-icon" size={17} /></Button>}>
        <MenuItem onSelect={() => choose({ tab: 'context' })}><SlidersHorizontal size={15} />{uiT('上下文')}</MenuItem><MenuItem onSelect={onTrace}><Activity size={15} />{uiT('轨迹')}</MenuItem><MenuItem onSelect={() => choose({ tab: 'logs' })}><FileText size={15} />{uiT('日志')}</MenuItem>
      </Menu>
    </nav>}>
    {tab === 'wiki' && <StoryWiki key={story.id} story={story} />}
    {tab === 'state' && <VariablesPanel story={story} latestReplyId={latestReplyId} busy={runs.some(run => ['queued', 'running', 'waiting_user'].includes(run.status))} />}{tab === 'summary' && <SummaryPanel story={story} />}
    {tab === 'files' && <FilesPanel key={story.id} storyId={story.id} />}{tab === 'context' && <ContextPanel key={story.id} storyId={story.id} runs={runs} />}{tab === 'logs' && <StoryLogs key={story.id} storyId={story.id} />}
    {tab === 'history' && <ConversationHistory storyId={story.id} busy={historyBusy} onJump={onJump} />}
    {tab === 'reading' && <ReadingPanel />}
  </InspectorSurface>
}
