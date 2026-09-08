import type { StoryPanelTab, StoryPanelTarget } from './panel.tsx'

const tabs: StoryPanelTab[] = ['wiki', 'state', 'summary', 'files', 'context', 'logs']
function saved() {
  try {
    const value = JSON.parse(localStorage.getItem('rp-story-panel') ?? 'null')
    if (value && typeof value.open === 'boolean' && tabs.includes(value.tab)) return value as { open: boolean; tab: StoryPanelTab }
  } catch { /* Optional layout persistence does not prevent reading. */ }
  return { open: false, tab: 'wiki' as StoryPanelTab }
}
export function preferredPanel(): StoryPanelTarget { return { tab: saved().tab } }
export function initialPanel(): StoryPanelTarget | null { const value = saved(); return value.open ? { tab: value.tab } : null }
export function rememberPanel(target: StoryPanelTarget | null) {
  // Only the panel's layout preference is persisted, never story content.
  const tab = target && tabs.includes(target.tab as StoryPanelTab) ? target.tab : saved().tab
  try { localStorage.setItem('rp-story-panel', JSON.stringify({ open: !!target, tab })) } catch { /* The mounted panel remains usable without persistence. */ }
}
