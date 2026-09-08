import { uiT, useUiLanguage } from "./lib/i18n.ts"
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { api, queryClient, useAction } from './lib/api.ts'
import { Button, ErrorNotice, Field, Input } from './components/ui.tsx'
import { Shell } from './components/shell.tsx'
import { EntryState, WorkspaceConnectionNotice } from './components/app-states.tsx'
import { isSessionExpired } from './lib/error-feedback.ts'
export { HomePage } from './pages/home.tsx'

export function App() {
  useUiLanguage()
  const auth = useQuery({ queryKey: ['auth'], queryFn: ({ signal }) => api<{ authenticated: boolean; configured: boolean }>('/auth/session', 'GET', undefined, signal) })
  const previousError = useRef<Error | null>(null)
  useEffect(() => { if (auth.error) previousError.current = auth.error; else if (!auth.isFetching) previousError.current = null }, [auth.error, auth.isFetching])
  // Query retries clear an initial error before they resolve. Keep recovery stable meanwhile.
  const error = auth.error ?? (auth.isFetching ? previousError.current : null)
  const retry = () => { void auth.refetch() }
  if (!auth.data) return <EntryState error={error} busy={auth.isFetching} retry={retry} />
  if (!auth.data.configured) return <EntryState configured={false} error={error} busy={auth.isFetching} retry={retry} />
  if (!auth.data.authenticated || isSessionExpired(error)) return <Login connectionError={error} retry={retry} retrying={auth.isFetching} />
  // A background connection failure must not unmount the workspace and its drafts.
  return <Shell notice={error && <WorkspaceConnectionNotice error={error} busy={auth.isFetching} retry={retry} />} />
}
function Login({ connectionError, retry, retrying }: { connectionError: Error | null; retry: () => void; retrying: boolean }) {
  useUiLanguage()
  const [password, setPassword] = useState(''), action = useAction()
  return <main className="auth-page"><form className="login-form" onSubmit={event => { event.preventDefault(); void action.run(async () => { await api('/auth/login', 'POST', { password }); setPassword(''); await queryClient.invalidateQueries({ queryKey: ['auth'] }) }) }}>
    <p className="eyebrow">pi-roleplay</p><h1>{uiT("你的创作空间")}</h1><p className="muted">{uiT("登录后继续对话、创作和修改。")}</p>
    <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden /><Field label={uiT("管理员密码")}><Input autoFocus type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></Field><ErrorNotice error={action.error ?? connectionError} retry={!action.error && connectionError ? retry : undefined} retrying={retrying} /><Button type="submit" tone="primary" disabled={action.busy}>{action.busy ? uiT("正在登录…") : uiT("登录")}<ArrowUpRight size={17} /></Button>
  </form></main>
}
