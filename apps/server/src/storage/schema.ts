import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AssetKind, JsonObject, JsonValue, RunStatus } from '../../../../packages/rp-core/src/types.ts'

export const stories = sqliteTable('stories', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: text('data', { mode: 'json' }).$type<JsonObject>().notNull(),
  idempotencyKey: text('idempotency_key'),
  createdAt: text('created_at').notNull(),
})

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<AssetKind>().notNull(),
  name: text('name').notNull(),
  revision: integer('revision').notNull(),
  data: text('data', { mode: 'json' }).$type<JsonObject>().notNull(),
  sourceHash: text('source_hash'),
  sourceCharacterId: text('source_character_id'),
  avatarFileId: text('avatar_file_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  createdAt: text('created_at').notNull(),
})

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull(),
  inputHash: text('input_hash').notNull(),
  turnId: text('turn_id').notNull(),
  status: text('status').$type<RunStatus>().notNull(),
  draft: text('draft').notNull().default(''),
  error: text('error', { mode: 'json' }).$type<{ code: string; message: string } | null>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<JsonValue>().notNull(),
})

/** Appearance assets stay in the private application DB, outside model/tool attachment storage. */
export const backgroundImages = sqliteTable('background_images', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  size: integer('size').notNull(),
  content: blob('content', { mode: 'buffer' }).notNull(),
  thumbnail: blob('thumbnail', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull(),
})
