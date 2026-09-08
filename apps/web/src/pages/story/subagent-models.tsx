import { StatusNotice } from '../../components/status-notice.tsx'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bot, Feather, RotateCcw, Workflow } from 'lucide-react'
import { resolveModelSelection, type ModelSelection, type SubagentCatalog } from '../../../../../packages/rp-core/src/agents/catalog.ts'
import type { ModelRoute, StorySnapshot } from '../../../../../packages/rp-core/src/types.ts'
import { CancelButton, EditorForm } from '../../components/form-guard.tsx'
import { ModelPicker } from '../../components/model-picker.tsx'
import { SettingsGroup } from '../../components/settings-layout.tsx'
import { Button, ErrorNotice, Loading, Modal } from '../../components/ui.tsx'
import { api, refreshStory, useAction, useModels, useSettings } from '../../lib/api.ts'
import { uiT, useUiLanguage } from '../../lib/i18n.ts'

export function StorySubagentModels({ story, disabled }: { story: StorySnapshot; disabled: boolean }) {
  useUiLanguage()
  const [open, setOpen] = useState(false)
  return <>
    <Button tone="quiet" className="panel-toggle" aria-label={uiT('会话子代理')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Bot size={17} /><span>{uiT('子代理')}</span>
    </Button>
    <Modal open={open} onOpenChange={setOpen} title={uiT('会话子代理')} description={uiT('仅对当前会话生效；未单独设置的项目跟随全局。')}
      size="form" className="settings-modal story-subagents-modal">
      {open && <StorySubagentForm story={story} disabled={disabled} done={() => setOpen(false)} />}
    </Modal>
  </>
}

function StorySubagentForm({ story, disabled, done }: { story: StorySnapshot; disabled: boolean; done: () => void }) {
  const catalog = useQuery({ queryKey: ['subagents'], queryFn: () => api<SubagentCatalog>('/settings/subagents') })
  const models = useModels(), preferences = useSettings(), action = useAction()
  const [baseline, setBaseline] = useState(() => ({ profile: structuredClone(story.profile), revision: story.revision }))
  const [writerRoute, setWriterRoute] = useState<ModelSelection | undefined>(baseline.profile.runtime.writerRoute)
  const [routes, setRoutes] = useState<Record<string, ModelSelection>>(() => structuredClone(baseline.profile.runtime.subagentRoutes ?? {}))
  const dirty = JSON.stringify([writerRoute, routes]) !== JSON.stringify([baseline.profile.runtime.writerRoute, baseline.profile.runtime.subagentRoutes ?? {}])
  useEffect(() => {
    if (!dirty && !action.busy) {
      setBaseline({ profile: structuredClone(story.profile), revision: story.revision })
      setWriterRoute(story.profile.runtime.writerRoute); setRoutes(structuredClone(story.profile.runtime.subagentRoutes ?? {}))
    }
  }, [story.revision, dirty, action.busy])
  const mainDefault = models.data?.effectiveMain
  const main = story.profile.runtime.provider && story.profile.runtime.model
    ? { provider: story.profile.runtime.provider, model: story.profile.runtime.model, reasoningEffort: story.profile.runtime.reasoningEffort }
    : mainDefault ? { ...mainDefault, reasoningEffort: story.profile.runtime.reasoningEffort ?? mainDefault.reasoningEffort } : undefined
  const describe = (route: ModelRoute | undefined) => {
    if (!route) return uiT('尚未选择模型')
    const model = models.data?.models.find(item => item.provider === route.provider && item.model === route.model)
    return [model?.label ?? route.model,
      models.data && (!model || !model.configured) ? uiT('当前不可用') : null].filter(Boolean).join(' · ')
  }
  const change = (id: string, route: ModelSelection | undefined) => {
    if (id === 'writer') setWriterRoute(route)
    else setRoutes(current => { const next = { ...current }; if (route) next[id] = route; else delete next[id]; return next })
  }
  if (catalog.isPending) return <Loading />
  if (!catalog.data) return <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} retrying={catalog.isFetching} />
  const picker = (id: string, name: string, globalRoute: ModelSelection, layout: 'row' | 'compact') => {
    const route = id === 'writer' ? writerRoute : routes[id]
    const globalModel = globalRoute.kind === 'fixed' ? globalRoute : main ? resolveModelSelection(globalRoute, main) : undefined
    return <ModelPicker label={uiT('%{name} 模型', { name })} layout={layout} value={route?.kind === 'fixed' ? route : null}
      defaultChoice={{ selected: route === undefined, label: uiT('使用全局默认'), detail: describe(globalModel), onSelect: () => change(id, undefined) }}
      inheritLabel={uiT('跟随本会话主模型')} inheritDetail={describe(main)}
      inheritedReasoning={{ route: (route === undefined ? globalModel : main) ?? null, value: route?.reasoningEffort,
        label: route === undefined ? uiT('使用全局默认') : uiT('跟随本会话主模型'),
        onChange: reasoningEffort => change(id, route === undefined && reasoningEffort === undefined ? undefined : { ...(route ?? globalRoute), reasoningEffort }) }}
      onChange={next => change(id, next ? { kind: 'fixed', ...next } : { kind: 'inherit' })} />
  }
  const tasksPaused = preferences.data && !preferences.data.preferences.subagentsEnabled
  const taskDescription = tasksPaused ? uiT('全局已暂停任务子代理。配置会保留，Writer 正常工作。')
    : story.profile.runtime.executionMode === 'agent' ? uiT('按调用说明参与规划、检查和润色，协助 Writer 完成创作。')
      : uiT('当前为 Chat 模式，以下配置在 Agent 模式下生效。')
  const orphaned = Object.keys(routes).filter(id => !catalog.data!.subagents.some(agent => agent.id === id))
  return <EditorForm className="story-subagents-form" dirty={dirty} busy={action.busy} onSubmit={() => {
    if (!dirty || disabled) return
    void action.run(async () => {
      const { writerRoute: _writer, subagentRoutes: _tasks, ...rest } = baseline.profile.runtime
      await api(`/stories/${story.id}/profile`, 'PUT', { expectedRevision: baseline.revision,
        profile: { ...baseline.profile, runtime: { ...rest, ...(writerRoute ? { writerRoute } : {}), ...(Object.keys(routes).length ? { subagentRoutes: routes } : {}) } },
      })
      await refreshStory(story.id); done()
    })
  }}>
    {disabled && <StatusNotice compact tone="paused" title={uiT('子代理设置暂不可修改')}><p>{uiT('当前会话正在处理内容，结束后即可修改子代理模型。')}</p></StatusNotice>}
    <fieldset disabled={disabled} className="story-subagent-list">
      <SettingsGroup className="story-writer-section" title={<span className="story-writer-title"><span className="story-writer-mark"><Feather size={20} aria-hidden="true" /></span><span>Writer<small>{uiT('正文写作')}</small></span></span>}
        description={uiT('负责把角色、设定与写作要求写成故事正文。')} actions={<span className="story-agent-scope">Chat · Agent</span>}>
        {picker('writer', 'Writer', catalog.data.writer.route, 'row')}
      </SettingsGroup>
      <SettingsGroup className="story-task-section" title={<span className="story-task-title"><Workflow size={17} aria-hidden="true" />{uiT('协作子代理')}</span>}
        description={taskDescription} actions={<span className="story-agent-scope">{uiT('仅 Agent 模式')}</span>}>
        {catalog.data.subagents.map(agent => <section className="story-subagent" key={agent.id} aria-label={agent.name}>
          <div className="story-subagent-row">
            <div className="story-subagent-identity"><h4>{agent.name}</h4><span>{agent.enabled ? uiT('全局已启用') : uiT('全局已停用')}</span></div>
            {picker(agent.id, agent.name, agent.route, 'compact')}
          </div>
          {agent.description && <details className="story-subagent-contract"><summary aria-label={uiT('查看%{name}的调用说明', { name: agent.name })}>{uiT('调用说明')}</summary><p>{agent.description}</p></details>}
        </section>)}
        {!catalog.data.subagents.length && <p className="story-subagents-empty">{uiT('尚未添加协作子代理。可在全局设置的“子代理”中添加。')}</p>}
      </SettingsGroup>
      {orphaned.length > 0 && <StatusNotice compact title={uiT('部分子代理设置已失效')} actions={<Button onClick={() => setRoutes(current => Object.fromEntries(Object.entries(current).filter(([id]) => !orphaned.includes(id))))}>{uiT('移除失效设置')}</Button>}><p>{uiT('部分子代理已从全局删除，其会话模型设置不再生效。')}</p></StatusNotice>}
    </fieldset>
    <ErrorNotice error={action.error} />
    <div className="form-actions sticky-actions">
      <Button tone="quiet" aria-label={uiT('全部使用全局默认')} disabled={disabled || writerRoute === undefined && !Object.keys(routes).length} onClick={() => { setWriterRoute(undefined); setRoutes({}) }}><RotateCcw size={14} />{uiT('恢复全局默认')}</Button>
      <CancelButton onCancel={done} /><Button tone="primary" type="submit" disabled={disabled || !dirty}>{uiT('保存')}</Button>
    </div>
  </EditorForm>
}
