import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { requireValue } from '../../../../packages/rp-core/src/errors.ts'
import type { AssetRepository } from '../storage/asset-repository.ts'

const KEY = 'private.admin'
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
interface AdminRecord { version: 1; salt: string; hash: string; epoch: string; updatedAt: string }

/** One administrator. Password resets rotate the epoch and revoke every existing encrypted session. */
export class AuthService {
  constructor(private readonly assets: AssetRepository) {}
  configured() { return this.record() !== null }
  epoch() { return this.record()?.epoch ?? null }

  async setPassword(password: string) {
    requireValue(typeof password === 'string' && [...password].length >= 12 && password.length <= 1024, 'INVALID_PASSWORD', '管理员密码需要 12 至 1024 个字符。')
    const salt = randomBytes(16)
    const hash = await derive(password, salt)
    const record: AdminRecord = { version: 1, salt: salt.toString('base64url'), hash: hash.toString('base64url'), epoch: randomUUID(), updatedAt: new Date().toISOString() }
    this.assets.setSetting(KEY, { ...record })
    return { configured: true }
  }

  async verify(password: string): Promise<string | null> {
    requireValue(typeof password === 'string' && password.length > 0 && password.length <= 1024, 'INVALID_PASSWORD', '请填写有效的管理员密码。')
    const record = this.record()
    if (!record) return null
    const candidate = await derive(password, Buffer.from(record.salt, 'base64url'))
    const valid = timingSafeEqual(candidate, Buffer.from(record.hash, 'base64url'))
    return valid && this.epoch() === record.epoch ? record.epoch : null
  }

  private record(): AdminRecord | null {
    const value = this.assets.getSetting(KEY)
    if (value === undefined) return null
    requireValue(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && typeof value.salt === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.salt)
      && typeof value.hash === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value.hash) && typeof value.epoch === 'string' && /^[0-9a-f-]{36}$/.test(value.epoch), 'AUTH_CONFIG_INVALID', '管理员配置不正确，请通过管理命令重置密码。', 500)
    return value as unknown as AdminRecord
  }
}

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, PARAMS, (error, result) => error ? reject(error) : resolve(result)))
}
