import { RpError } from '../../../../packages/rp-core/src/errors.ts'
import type { JsonValue } from '../../../../packages/rp-core/src/types.ts'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from '@earendil-works/pi-ai'

/** Infer parameters from each schema before erasing them at Pi's heterogeneous tool-array boundary. */
export function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool<any> { return tool }

/** Pi returns thrown messages to the model; preserve structured correction details. */
export async function runTool<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) {
    if (error instanceof RpError) throw new Error(JSON.stringify({ code: error.code, message: error.message, details: error.details }))
    throw error
  }
}
export function toolResult(operation: () => Promise<JsonValue>) {
  return runTool(async () => {
    const result = await operation()
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
  })
}
