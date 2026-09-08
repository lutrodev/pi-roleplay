import { uiT, useUiLanguage } from "../lib/i18n.ts"
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'
import { IconButton } from './ui.tsx'

export const ShellContext = createContext({ collapsed: false, mobile: false, toggleNavigation: () => {}, createStory: () => {}, searchStories: () => {} })
export const useShell = () => useContext(ShellContext)

export function NavigationToggle() {
  useUiLanguage()
  const shell = useShell()
  if (!shell.mobile && !shell.collapsed) return null
  return <IconButton className="navigation-toggle" label={shell.mobile ? uiT("打开导航") : shell.collapsed ? uiT("展开导航") : uiT("收起导航")} onClick={shell.toggleNavigation} aria-keyshortcuts="Control+b Meta+b"><PanelLeft size={18} /></IconButton>
}

export function PageHeader({ title, detail, actions }: { title: string; detail?: ReactNode; actions?: ReactNode }) {
  const language = useUiLanguage()
  useEffect(() => { document.title = `${title} · pi-roleplay`; return () => { document.title = uiT("pi-roleplay · 创作工作台") } }, [title, language])
  return <header className="page-bar"><div className="page-bar-title"><NavigationToggle /><h1 title={title}>{title}</h1>{detail && <span className="page-bar-detail">{detail}</span>}</div>{actions && <div className="header-actions">{actions}</div>}</header>
}
