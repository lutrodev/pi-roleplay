import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** Separate credential domains derive distinct keys; the record ID is authenticated too. */
export class CredentialCipher {
  private readonly key: Buffer
  constructor(sessionKey: Buffer, domain: string) { this.key = createHash('sha256').update(domain).update(sessionKey).digest() }
  encrypt(id: string, value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(id))
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }
  decrypt(id: string, encrypted: string) {
    const bytes = Buffer.from(encrypted, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  }
}
