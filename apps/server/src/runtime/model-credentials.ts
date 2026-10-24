import { createHash, createPrivateKey } from 'node:crypto'
import { JWT } from 'google-auth-library'
import { GOOGLE_TOKEN_URL, SERVICE_ACCOUNT_MAX_LENGTH, validGoogleProject, type ModelAuth } from '../../../../packages/protocol/src/model-auth.ts'
import { RpError, requireValue } from '../../../../packages/rp-core/src/errors.ts'

interface ServiceAccount { type: 'service_account'; project_id: string; client_email: string; private_key: string; private_key_id?: string }

/** Whitelist service-account fields; never accept ADC files, executable credentials, or custom token hosts. */
export function parseServiceAccount(value: unknown): ServiceAccount {
  requireValue(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= SERVICE_ACCOUNT_MAX_LENGTH, 'MODEL_CREDENTIAL_INVALID', '服务账号 JSON 不能超过 32 KB。')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new RpError('MODEL_CREDENTIAL_INVALID', '请输入有效的服务账号 JSON。') }
  requireValue(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'MODEL_CREDENTIAL_INVALID', '请输入服务账号 JSON 对象。')
  const json = parsed as Record<string, unknown>
  requireValue(json.type === 'service_account', 'MODEL_CREDENTIAL_INVALID', 'JSON 类型必须为 service_account，请使用 Google Cloud 下载的服务账号密钥。')
  requireValue(typeof json.project_id === 'string' && validGoogleProject(json.project_id), 'MODEL_CREDENTIAL_INVALID', '服务账号 JSON 缺少有效的 project_id。')
  requireValue(typeof json.client_email === 'string' && /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(json.client_email) && json.client_email.length <= 254, 'MODEL_CREDENTIAL_INVALID', '服务账号 JSON 缺少有效的 client_email。')
  requireValue(typeof json.private_key === 'string' && json.private_key.length <= 16384, 'MODEL_CREDENTIAL_INVALID', '服务账号 JSON 缺少有效的 private_key。')
  requireValue(json.private_key_id === undefined || typeof json.private_key_id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(json.private_key_id), 'MODEL_CREDENTIAL_INVALID', '服务账号 JSON 的 private_key_id 不正确。')
  requireValue((json.token_uri === undefined || json.token_uri === GOOGLE_TOKEN_URL) && (json.universe_domain === undefined || json.universe_domain === 'googleapis.com'), 'MODEL_CREDENTIAL_INVALID', '仅支持 Google Cloud 官方服务账号和令牌地址。')
  try {
    const key = createPrivateKey(json.private_key)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error()
  } catch { throw new RpError('MODEL_CREDENTIAL_INVALID', '服务账号 private_key 不是有效的 RSA 私钥。') }
  return { type: 'service_account', project_id: json.project_id, client_email: json.client_email, private_key: json.private_key,
    ...(typeof json.private_key_id === 'string' ? { private_key_id: json.private_key_id } : {}) }
}

export function credentialInput(input: { apiKey?: unknown; serviceAccountJson?: unknown }, auth?: ModelAuth) {
  if (auth === 'google-service-account') {
    requireValue(input.apiKey === undefined, 'MODEL_CREDENTIAL_INVALID', 'Vertex AI 需要服务账号 JSON，不能填写 API 密钥。')
    return input.serviceAccountJson === undefined ? undefined : JSON.stringify(parseServiceAccount(input.serviceAccountJson))
  }
  requireValue(input.serviceAccountJson === undefined, 'MODEL_CREDENTIAL_INVALID', '请在 Google Cloud Vertex AI 连接中导入服务账号 JSON。')
  requireValue(input.apiKey === undefined || typeof input.apiKey === 'string' && input.apiKey.trim().length > 0 && input.apiKey.length <= 8192 && !/[\r\n\0]/.test(input.apiKey), 'MODEL_CONFIG_INVALID', 'API 密钥格式不正确。')
  return typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined
}

/** Only short-lived access tokens are cached. Private keys never reach Pi, tools, or plaintext files. */
export class ModelCredentials {
  private tokens = new Map<string, { token: string; expires: number }>()
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  clear() { this.tokens.clear() }
  async resolve(auth: ModelAuth | undefined, secret: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!auth) return secret
    const account = parseServiceAccount(secret), fingerprint = createHash('sha256').update(secret).digest('hex')
    const cached = this.tokens.get(fingerprint)
    if (cached && cached.expires > Date.now() + 60_000) return cached.token
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const client = new JWT({ email: account.client_email, key: account.private_key, keyId: account.private_key_id,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      transporterOptions: { retry: false, signal: bounded, fetchImplementation: (url, init) => this.fetcher(url, { ...init, signal: bounded, redirect: 'error' }) },
    })
    try {
      const credentials = await client.authorize()
      bounded.throwIfAborted()
      requireValue(typeof credentials.access_token === 'string' && credentials.access_token.length > 0 && !/[\s\0]/.test(credentials.access_token) && Number.isFinite(credentials.expiry_date) && credentials.expiry_date! > Date.now(), 'MODEL_AUTH_FAILED', 'Google Cloud 未返回有效的访问令牌。', 422)
      for (const [id, token] of this.tokens) if (token.expires <= Date.now() + 60_000) this.tokens.delete(id)
      if (this.tokens.size >= 64) this.tokens.delete(this.tokens.keys().next().value!)
      this.tokens.set(fingerprint, { token: credentials.access_token, expires: credentials.expiry_date! })
      return credentials.access_token
    } catch {
      if (signal.aborted) throw new RpError('MODEL_REQUEST_ABORTED', '模型请求已停止。')
      if (bounded.aborted) throw new RpError('MODEL_TEST_TIMEOUT', 'Google Cloud 认证超时，请稍后重试。', 504)
      // Google auth errors may include the signed assertion; never propagate the library error.
      throw new RpError('MODEL_AUTH_FAILED', 'Google Cloud 认证失败，请检查服务账号 JSON、密钥状态和服务器时间。', 422)
    }
  }
}
