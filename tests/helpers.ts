import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppDatabase } from '../apps/server/src/storage/database.ts'
import { AssetRepository } from '../apps/server/src/storage/asset-repository.ts'
import { StoryRepository } from '../apps/server/src/storage/story-repository.ts'
import { FileRepository } from '../apps/server/src/storage/file-repository.ts'
import type { RunRecord, StoryMessage, StoryProfile } from '../packages/rp-core/src/types.ts'

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-roleplay-test-'))
  const filename = join(directory, 'app.sqlite')
  const database = new AppDatabase(filename)
  return { directory, filename, database, assets: new AssetRepository(database), stories: new StoryRepository(database), files: new FileRepository(database, join(directory, 'inputs')),
    close() { if (database.sqlite.open) database.close(); rmSync(directory, { recursive: true, force: true }) },
  }
}

export function profile(): StoryProfile {
  return {
    revision: 1, playerCharacterId: 'player',
    cast: [{ characterId: 'player', name: '我', controller: 'user' }],
    scene: { openingSource: 'skip' }, resources: { lorebooks: [], writingStyles: [] }, runtime: { executionMode: 'chat' },
  }
}

export function message(role: 'user' | 'assistant', text: string, overrides: Partial<StoryMessage> = {}): StoryMessage {
  return { id: randomUUID(), role, text, kind: 'message', attachmentIds: [], turnId: randomUUID(), runId: null, createdAt: new Date().toISOString(), ...overrides }
}

/** Domain/HTTP fixtures bypass Pi; record the simulated response as well as its reading projection. */
export function recordModelReply(stories: StoryRepository, run: RunRecord, ownerMessageId: string, text: string) {
  stories.append(run.storyId, { type: 'model.message', data: { runId: run.id, ownerMessageId, role: 'assistant', message: {
    role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'test', model: 'test', timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } } })
}
