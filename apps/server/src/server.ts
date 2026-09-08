import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RpError, requireValue } from '../../../packages/rp-core/src/errors.ts'
import { AppDatabase } from './storage/database.ts'
import { AssetRepository } from './storage/asset-repository.ts'
import { FileRepository, MAX_UPLOAD_BYTES } from './storage/file-repository.ts'
import { StoryRepository } from './storage/story-repository.ts'
import { AuthService } from './services/auth-service.ts'
import { FileService } from './services/file-service.ts'
import { StoryService } from './services/story-service.ts'
import { QuestionService } from './services/question-service.ts'
import { ContextService } from './services/context-service.ts'
import { TurnService } from './services/turn-service.ts'
import { SettingsService } from './services/settings-service.ts'
import { ToolSettingsService } from './services/tool-settings-service.ts'
import { WriterHistoryService } from './services/writer-history-service.ts'
import { registerWriterHistory } from './http/writer-history.ts'
import { registerToolSettings } from './http/tool-settings.ts'
import { SubagentService } from './services/subagent-service.ts'
import { SkillService } from './services/skill-service.ts'
import { SummaryService } from './services/summary-service.ts'
import { ModelRegistry } from './runtime/models.ts'
import { ModelCatalogService } from './services/model-catalog-service.ts'
import { registerModelCatalog } from './http/model-catalog.ts'
import { registerTrace } from './http/trace.ts'
import { TraceService } from './services/trace-service.ts'
import { ToolClient } from './runtime/tool-client.ts'
import { SystemTools } from './runtime/system-tools.ts'
import { RunExecutor } from './runtime/executor.ts'
import { ResourceFactory } from './runtime/resources.ts'
import { RunQueue } from './runtime/queue.ts'
import { registerAuthentication } from './http/auth.ts'
import { registerErrors } from './http/errors.ts'
import { Operations } from './services/operations.ts'
import { EventStreams } from './http/events.ts'
import { registerStoryRoutes } from './http/stories.ts'
import { InputQueueService } from './services/input-queue-service.ts'
import { registerInputRoutes } from './http/inputs.ts'
import { registerAssetRoutes } from './http/assets.ts'
import { registerFileRoutes } from './http/files.ts'
import { registerSettingsRoutes } from './http/settings.ts'
import { registerSummaryRoutes } from './http/summaries.ts'
import { registerContextPreview } from './http/context.ts'
import { SidebarService } from './services/sidebar-service.ts'
import { StoryDeletionService } from './services/story-deletion-service.ts'
import { registerSidebar } from './http/sidebar.ts'
import { WorkspaceService } from './services/workspace-service.ts'
import { registerWorkspaces } from './http/workspaces.ts'
import { BackgroundService } from './services/background-service.ts'
import { registerBackgrounds } from './http/backgrounds.ts'
import type { ServerConfig } from './config.ts'

export async function createServer(config: ServerConfig, dependencies: { logger?: boolean; modelOptions?: ConstructorParameters<typeof ModelRegistry>[1]; toolFetch?: typeof fetch; searchFetch?: typeof fetch } = {}) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 })
  const database = new AppDatabase(join(config.dataDirectory, 'app.sqlite'))
  const app = Fastify({ logger: dependencies.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
    bodyLimit: 12 * 1024 * 1024, requestTimeout: 60000, connectionTimeout: 65000, ajv: { customOptions: { removeAdditional: false } },
  })
  // Routes capture their error handler during plugin boot, including the authentication routes.
  registerErrors(app)
  let queue: RunQueue | undefined
  let summaries: SummaryService | undefined
  const operations = new Operations(config.dataDirectory, () => ({
    runs: (database.sqlite.prepare("SELECT count(*) AS count FROM runs WHERE status IN ('queued','running','waiting_user')").get() as { count: number }).count,
    background: summaries?.activeCount ?? 0,
  }), () => queue?.wake())
  operations.register(app)
  try {
    const assets = new AssetRepository(database), stories = new StoryRepository(database), files = new FileRepository(database, join(config.dataDirectory, 'inputs'))
    const modelCatalog = new ModelCatalogService(assets, config.models, config.sessionKey, dependencies.modelOptions, () =>
      Boolean((database.sqlite.prepare("SELECT count(*) AS count FROM runs WHERE status IN ('running','waiting_user')").get() as { count: number }).count || summaries?.activeCount))
    const models = modelCatalog.models
    const auth = new AuthService(assets), settings = new SettingsService(assets, models), subagents = new SubagentService(assets, models), skills = new SkillService(config.skillRoots)
    const service = new StoryService(stories, assets, files), fileService = new FileService(files, assets, stories)
    const questions = new QuestionService(stories), contexts = new ContextService(stories, assets), turns = new TurnService(stories)
    const client: ToolClient = new ToolClient(config.tools.url, config.tools.token, dependencies.toolFetch, id => workspaces.forStory(id))
    const workspaces: WorkspaceService = new WorkspaceService(stories, client)
    const toolSettings = new ToolSettingsService(assets, config.sessionKey, config.search, dependencies.modelOptions?.env)
    const writerHistory = new WriterHistoryService(assets)
    const summaryService = new SummaryService(stories, models, () => app.log.error({ code: 'SUMMARY_JOURNAL_FAILED' }, 'Summary failed'), () => queue?.wake())
    summaries = summaryService
    const inputs = new InputQueueService(service)
    const executor = new RunExecutor(stories, contexts, turns, models, files, summaryService, inputs)
    settings.snapshot(); subagents.snapshot(); assets.ensureDefaults()
    queue = new RunQueue(stories, async (runId, signal) => {
      const prefs = settings.snapshot().preferences
      const capturedTools = toolSettings.capture(dependencies.searchFetch)
      const capturedWriterHistory = writerHistory.capture()
      const system = new SystemTools(client, fileService, questions, capturedTools.search, capturedTools.settings)
      const selected = prefs.mainModel ?? config.defaultMain
      const profile = stories.snapshot(stories.run(runId).storyId).profile
      const main = profile.runtime.provider && profile.runtime.model ? { provider: profile.runtime.provider, model: profile.runtime.model } : selected
      requireValue(main, 'MODEL_NOT_CONFIGURED', '请先在系统设置选择主模型。')
      const factory = new ResourceFactory(service, turns, system, models, skills, subagents, main, {
        skills: prefs.skills, disabledSkills: prefs.disabledSkills, subagents: prefs.subagentsEnabled,
        identity: prefs.identity, writerHistory: capturedWriterHistory,
      })
      const resources = await factory.prepare(runId, signal)
      if (prefs.replyOptionsEnabled) resources.replyOptions = {
        config: prefs.replyOptions, enabled: () => settings.snapshot().preferences.replyOptionsEnabled,
      }
      await executor.execute(runId, signal, resources)
    }, error => app.log.error({ code: error instanceof RpError ? error.code : 'RUN_FAILED' }, 'Run failed'), () => operations.quiesced, () => inputs.promote(), runId => summaryService.settleRun(runId))
    const runs = queue
    const security = await registerAuthentication(app, auth, { publicOrigin: config.publicOrigin, sessionKey: config.sessionKey })
    await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 } })
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin').header('x-frame-options', 'DENY')
      if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
      return payload
    })
    app.get('/health', async () => ({ ok: true }))
    const sidebar = new SidebarService(assets, stories)
    registerStoryRoutes(app, service, runs, questions, workspaces, new StoryDeletionService(stories, sidebar, id => summaryService.hasStoryJob(id)))
    registerWorkspaces(app, workspaces)
    registerInputRoutes(app, inputs, runs)
    registerTrace(app, new TraceService(stories))
    registerAssetRoutes(app, assets, fileService)
    registerFileRoutes(app, fileService, client)
    registerSettingsRoutes(app, settings, skills, subagents, config.defaultMain)
    registerBackgrounds(app, new BackgroundService(assets))
    registerToolSettings(app, toolSettings)
    registerWriterHistory(app, writerHistory)
    registerSidebar(app, sidebar)
    registerModelCatalog(app, modelCatalog)
    registerContextPreview(app, contexts, settings, config.defaultMain)
    registerSummaryRoutes(app, summaryService, storyId => {
      const runtime = stories.snapshot(storyId).profile.runtime, selected = settings.snapshot().preferences.mainModel ?? config.defaultMain
      const main = runtime.provider && runtime.model ? { provider: runtime.provider, model: runtime.model } : selected
      requireValue(main, 'MODEL_NOT_CONFIGURED', '请先在系统设置选择主模型。')
      return { ...main, ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}) }
    })
    new EventStreams(stories, security.authenticated).register(app)
    app.get('/api/system/status', async () => {
      const tools = await client.health().then(value => ({ available: true, ...value }), () => ({ available: false }))
      const configuredTools = toolSettings.snapshot()
      return { version: '0.1.0', operations: operations.status(), tools, models: models.list(), searchConfigured: Boolean(configuredTools.settings.search.baseUrl && configuredTools.searchKey.configured),
        runs: database.sqlite.prepare("SELECT status, count(*) AS count FROM runs WHERE status IN ('queued','running','waiting_user') GROUP BY status").all() }
    })
    if (config.webDirectory) {
      await access(join(config.webDirectory, 'index.html'))
      await app.register(staticFiles, { root: config.webDirectory, prefix: '/', index: false, maxAge: 0, dotfiles: 'deny' })
      app.setNotFoundHandler((request, reply) => {
        if (request.method !== 'GET' || request.url.startsWith('/api/') || request.url.startsWith('/assets/') || !request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '这个页面或接口不存在。' } })
        return reply.header('cache-control', 'no-cache').sendFile('index.html')
      })
      app.get('/', async (_request, reply) => reply.header('cache-control', 'no-cache').sendFile('index.html'))
    }
    app.addHook('onReady', async () => { summaryService.recover(); if (config.controlSocket) await operations.listen(config.controlSocket); runs.start() })
    app.addHook('preClose', async () => { modelCatalog.close(); await operations.close(); await runs.close(); await summaryService.close() })
    app.addHook('onClose', async () => { if (database.sqlite.open) database.close() })
    return { app, database, assets, stories, workspaces, files, fileService, service, auth, settings, toolSettings, writerHistory, subagents, skills, models, modelCatalog, client, queue: runs, summaries: summaryService, operations }
  } catch (error) {
    await operations.close(); await queue?.close(); await summaries?.close(); await app.close(); if (database.sqlite.open) database.close(); throw error
  }
}
