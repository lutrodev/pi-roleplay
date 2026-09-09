import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button, ErrorNotice, Loading } from '../../components/ui.tsx'
import { SettingRow, SettingsGroup } from '../../components/settings-layout.tsx'
import { api } from '../../lib/api.ts'
import { uiT, uiLocale } from '../../lib/i18n.ts'

export function SystemStatus({ onNavigate }: { onNavigate: (tab: 'models' | 'tools') => void }) {
  const query = useQuery({ queryKey: ['system-status'], queryFn: () => api<{ version: string; operations: { quiesced: boolean; backup: { status: string; completedAt?: string; file?: string } | null }; tools: { available: boolean; active?: number }; models: { label: string; configured: boolean }[]; searchConfigured: boolean; runs: { status: string; count: number }[] }>('/system/status'), refetchInterval: 15000 })
  return <section className="settings-form stack">
    <div className="section-heading status-refresh"><span className="muted">{query.dataUpdatedAt ? uiT('上次更新：%{time}', { time: new Date(query.dataUpdatedAt).toLocaleTimeString(uiLocale()) }) : uiT(query.error ? '状态暂不可用' : '正在读取状态')}</span><Button disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={15} className={query.isFetching ? 'spinner' : undefined} />{uiT('刷新')}</Button></div>
    <ErrorNotice source="read" error={query.error} />{query.isPending && <Loading />}
    {query.data && <SettingsGroup>
      <SettingRow label={uiT('应用版本')}><span className="setting-status">{query.data.version}</span></SettingRow>
      <SettingRow label={uiT('工具服务')}><span className="setting-status">{query.data.tools.available ? uiT('可以连接') : uiT('暂时不可用')}</span></SettingRow>
      <SettingRow label={uiT('维护状态')}><span className="setting-status">{query.data.operations.quiesced ? uiT('备份维护中，暂缓写入') : uiT('正常使用')}</span></SettingRow>
      <SettingRow label={uiT('最近备份')}><span className="setting-status">{query.data.operations.backup ? <>{({ completed: uiT('备份完成'), restored: uiT('已从备份恢复'), failed: uiT('备份失败，请查看部署日志'), unreadable: uiT('备份记录无法读取') } as Record<string, string>)[query.data.operations.backup.status] ?? uiT('状态未知')}{query.data.operations.backup.completedAt && <small>{new Date(query.data.operations.backup.completedAt).toLocaleString(uiLocale())}</small>}</> : uiT('尚无备份记录')}</span></SettingRow>
      <SettingRow label={uiT('搜索')} help={query.data.searchConfigured ? uiT('已配置专用端点') : uiT('尚未配置')}><Button tone="quiet" className="setting-text-action" onClick={() => onNavigate('tools')}>{uiT('管理工具')}</Button></SettingRow>
      <SettingRow label={uiT('主任务')}><span className="setting-status">{query.data.runs.length ? query.data.runs.map(run => `${uiT(run.status)}：${run.count}`).join(' · ') : uiT('当前空闲')}</span></SettingRow>
      <SettingRow label={uiT('模型配置')} help={<>{uiT('%{configured} / %{total} 个模型已配置密钥', { configured: query.data.models.filter(model => model.configured).length, total: query.data.models.length })}<br />{uiT('连接能否生成回复，请在模型页测试。')}</>}><Button tone="quiet" className="setting-text-action" onClick={() => onNavigate('models')}>{uiT('管理模型')}</Button></SettingRow>
    </SettingsGroup>}
  </section>
}
