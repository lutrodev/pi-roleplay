import { loadConfig } from './config.ts'
import { createServer } from './server.ts'
import { RpError } from '../../../packages/rp-core/src/errors.ts'
import type { FastifyInstance } from 'fastify'

process.umask(0o077)
let application: FastifyInstance | undefined
let stage = '读取部署配置'
const sensitive: string[] = []
try {
  const { config, host, port } = await loadConfig()
  sensitive.push(config.tools.token, config.sessionKey.toString('hex'), config.sessionKey.toString('base64'))
  for (const model of config.models) if (process.env[model.keyEnv]) sensitive.push(process.env[model.keyEnv]!)
  if (config.search && process.env[config.search.keyEnv]) sensitive.push(process.env[config.search.keyEnv]!)
  stage = '初始化数据库与应用'
  const { app } = await createServer(config, { logger: true })
  application = app
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void app.close().catch(() => { process.stderr.write('服务关闭失败，请检查持久化目录。\n'); process.exitCode = 1 })
  })
  stage = '启动 HTTP 与本地控制接口'
  await app.listen({ host, port })
} catch (error) {
  await application?.close().catch(() => undefined)
  let diagnostic = error instanceof RpError ? error.message : error instanceof Error ? `${error.name}: ${error.message}` : '未知错误'
  for (const value of sensitive.filter(Boolean)) diagnostic = diagnostic.split(value).join('[redacted]')
  process.stderr.write(`${stage}失败：${diagnostic}\n`)
  process.exitCode = 1
}
