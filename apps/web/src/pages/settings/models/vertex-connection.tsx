import { useEffect, useRef, useState } from 'react'
import type { ModelConnection } from '../../../../../../apps/server/src/services/model-inspection.ts'
import { SERVICE_ACCOUNT_MAX_LENGTH, vertexBaseUrl } from '../../../../../../packages/protocol/src/model-auth.ts'
import { ErrorNotice, Field, Input, Textarea } from '../../../components/ui.tsx'
import { uiT } from '../../../lib/i18n.ts'

// Keep incomplete edits visible while the user types; the server validates the final endpoint.
function vertexFields(connection: ModelConnection) {
  const match = /\/projects\/([^/]*)\/locations\/([^/]*)\/endpoints\/openapi/.exec(connection.baseUrl)
  return { project: match?.[1] ?? '', location: match?.[2] ?? 'global' }
}
export function VertexProjectFields({ connection, onChange }: { connection: ModelConnection; onChange: (value: ModelConnection) => void }) {
  const { project, location } = vertexFields(connection)
  return <><Field label={uiT('Google Cloud 项目 ID')} help={uiT('默认从 JSON 读取，也可以使用已授权的其他项目。')}><Input required value={project} pattern={'(?:[a-z][a-z0-9\\-]{4,28}[a-z0-9]|[0-9]{6,30})'} onChange={event => onChange({ ...connection, baseUrl: vertexBaseUrl(event.target.value.trim(), location) })} placeholder="my-cloud-project" /></Field>
    <Field label={uiT('区域（Location）')} help={uiT('填写 global 或模型支持的区域，例如 us-central1。')}><Input required value={location} pattern="(?:global|[a-z]+(?:-[a-z]+)+[0-9]+)" onChange={event => onChange({ ...connection, baseUrl: vertexBaseUrl(project, event.target.value.trim()) })} placeholder="global" /></Field></>
}

function jsonError(value: string) {
  if (!value.trim()) return ''
  if (new TextEncoder().encode(value).length > SERVICE_ACCOUNT_MAX_LENGTH) return uiT('服务账号 JSON 不能超过 32 KB。')
  try {
    const json: unknown = JSON.parse(value)
    if (!json || typeof json !== 'object' || Array.isArray(json) || (json as { type?: unknown }).type !== 'service_account') return uiT('JSON 类型必须为 service_account，请使用 Google Cloud 下载的服务账号密钥。')
    const account = json as Record<string, unknown>
    if (!['project_id', 'client_email', 'private_key'].every(key => typeof account[key] === 'string' && account[key])) return uiT('服务账号 JSON 需要 project_id、client_email 和 private_key。')
    return ''
  } catch { return uiT('请输入有效的服务账号 JSON。') }
}
export function ServiceAccountField({ value, onChange, connection, onConnection, stored = false, disabled = false }: {
  value: string; onChange: (value: string) => void; connection: ModelConnection; onConnection: (connection: ModelConnection) => void; stored?: boolean; disabled?: boolean
}) {
  const textarea = useRef<HTMLTextAreaElement>(null), [fileError, setFileError] = useState<Error | null>(null)
  useEffect(() => { textarea.current?.setCustomValidity(jsonError(value)) }, [value])
  function change(next: string) {
    textarea.current?.setCustomValidity(jsonError(next))
    onChange(next); setFileError(null)
    if (!jsonError(next) && next.trim() && !vertexFields(connection).project) {
      const json = JSON.parse(next) as { project_id: string }
      onConnection({ ...connection, baseUrl: vertexBaseUrl(json.project_id, vertexFields(connection).location) })
    }
  }
  return <><Field label={uiT('服务账号 JSON')} help={stored ? uiT('留空保留当前服务账号。填写或导入新的 JSON 可替换。') : uiT('粘贴 Google Cloud 服务账号密钥 JSON，或从文件导入。凭证加密保存，不会提供给模型工具。')}><Textarea ref={textarea} className="code-input" rows={6} autoComplete="off" spellCheck={false} value={value} disabled={disabled} onChange={event => change(event.target.value)} placeholder={stored ? uiT('已配置 · 输入以替换') : '{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…" }'} /></Field>
    <Field label={uiT('导入 JSON 文件')}><Input type="file" accept=".json,application/json" disabled={disabled} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
      if (file.size > SERVICE_ACCOUNT_MAX_LENGTH) { setFileError(new Error(uiT('服务账号 JSON 不能超过 32 KB。'))); return }
      void file.text().then(text => { const error = jsonError(text); if (error || !text.trim()) setFileError(new Error(error || uiT('请输入有效的服务账号 JSON。'))); else change(text) }).catch(() => setFileError(new Error(uiT('无法读取 JSON 文件，请重新选择或粘贴内容。'))))
    }} /></Field><ErrorNotice error={fileError} /></>
}
