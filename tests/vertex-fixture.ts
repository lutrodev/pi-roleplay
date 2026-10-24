import { generateKeyPairSync } from 'node:crypto'
import { vertexBaseUrl } from '../packages/protocol/src/model-auth.ts'

/** Generated synthetic credentials, never a Google Cloud account. */
export function syntheticServiceAccount(project = 'synthetic-project') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const account = { type: 'service_account', project_id: project, private_key_id: 'synthetic-key-id',
    client_email: `synthetic@${project}.iam.gserviceaccount.com`, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token', universe_domain: 'googleapis.com' }
  return { account, json: JSON.stringify(account, null, 2), publicKey }
}
export const vertexConnection = { api: 'openai-completions' as const, auth: 'google-service-account' as const, baseUrl: vertexBaseUrl('synthetic-project', 'global') }
export function vertexResponse() {
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
