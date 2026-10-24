export type ModelAuth = 'google-service-account'
export const SERVICE_ACCOUNT_MAX_LENGTH = 32768
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const validGoogleProject = (value: string) => /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,30})$/.test(value)
export const validGoogleLocation = (value: string) => value === 'global' || /^[a-z]+(?:-[a-z]+)+\d+$/.test(value)

export function vertexBaseUrl(project: string, location: string) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`
}

/** Accept only the Google endpoint matching the authored project and region. */
export function parseVertexBaseUrl(value: string): { project: string; location: string } | undefined {
  const match = /^https:\/\/([^/]+)\/v1\/projects\/([^/]+)\/locations\/([^/]+)\/endpoints\/openapi\/?$/.exec(value)
  if (!match) return undefined
  const project = match[2]!, location = match[3]!
  if (!validGoogleProject(project) || !validGoogleLocation(location)) return undefined
  return value.replace(/\/$/, '') === vertexBaseUrl(project, location) ? { project, location } : undefined
}
