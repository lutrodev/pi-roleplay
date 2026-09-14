import type { Api } from '@earendil-works/pi-ai'

/** Anthropic's SDK adds /v1 itself. Keep any gateway prefix before that suffix. */
export function modelBaseUrl(api: Api | undefined, url: string) {
  const base = url.replace(/\/+$/, '')
  return api === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base
}

export function sameModelEndpoint(a: { api?: Api; baseUrl?: string }, b: { api?: Api; baseUrl?: string }) {
  return !!a.baseUrl && !!b.baseUrl && modelBaseUrl(a.api ?? b.api, a.baseUrl) === modelBaseUrl(b.api ?? a.api, b.baseUrl)
}
