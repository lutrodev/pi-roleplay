import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrations } from './migrations.ts'
import * as schema from './schema.ts'

export class AppDatabase {
  readonly sqlite: Database.Database
  readonly orm: ReturnType<typeof drizzle<typeof schema>>

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.sqlite = new Database(filename)
    try {
      this.sqlite.pragma('foreign_keys = ON')
      this.sqlite.pragma('journal_mode = WAL')
      this.sqlite.pragma('synchronous = FULL')
      this.sqlite.pragma('busy_timeout = 5000')
      this.sqlite.function('unicode_lower', { deterministic: true }, value => String(value ?? '').toLocaleLowerCase())
      this.migrate()
      this.orm = drizzle(this.sqlite, { schema })
    } catch (error) {
      this.sqlite.close()
      throw error
    }
  }

  transaction<T>(operation: () => T): T {
    return this.sqlite.transaction(() => {
      const result = operation()
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('Database transactions must be synchronous; await network or model calls outside them.')
      }
      return result
    }).immediate()
  }

  close() { this.sqlite.close() }

  private migrate() {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS __rp_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const applied = this.sqlite.prepare('SELECT version, checksum FROM __rp_migrations ORDER BY version').all() as { version: number; checksum: string }[]
    const known = new Map<number, string>(migrations.map(migration => [migration.version, createHash('sha256').update(migration.sql).digest('hex')]))
    for (const migration of applied) {
      if (known.get(migration.version) !== migration.checksum) throw new Error(`Database migration ${migration.version} is newer than this application or has changed. Restore a matching application version.`)
    }
    this.transaction(() => {
      for (const migration of migrations) {
        if (applied.some(row => row.version === migration.version)) continue
        this.sqlite.exec(migration.sql)
        this.sqlite.prepare('INSERT INTO __rp_migrations VALUES (?, ?, ?)').run(migration.version, known.get(migration.version), new Date().toISOString())
      }
    })
  }
}
