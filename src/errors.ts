export type IgErrorCode =
  | 'not-logged-in'
  | 'rate-limited'
  | 'challenge'
  | 'action-blocked'
  | 'not-found'
  | 'forbidden'
  | 'bad-request'
  | 'server-error'
  | 'html-response'
  | 'graphql-error'
  | 'no-doc-id'
  | 'busy'
  | 'paused'
  | 'other'

export class IgError extends Error {
  code: IgErrorCode
  status?: number
  body?: string
  constructor(code: IgErrorCode, message: string, extra: { status?: number; body?: string } = {}) {
    super(message)
    this.code = code
    this.status = extra.status
    this.body = extra.body?.slice(0, 500)
  }
}

/** Maps an Instagram response to a uniform error code. */
export const classify = (status: number, finalUrl: string, text: string): IgErrorCode | null => {
  const head = text.slice(0, 2000)
  if (/\/accounts\/login/.test(finalUrl)) return 'not-logged-in'
  if (/\/challenge\/|checkpoint_required|"checkpoint_url"|challenge_required/.test(finalUrl + head)) return 'challenge'
  if (/feedback_required|"spam":\s*true/.test(head)) return 'action-blocked'
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return /login_required/.test(head) ? 'not-logged-in' : 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 400) return 'bad-request'
  if (status >= 500) return 'server-error'
  if (status >= 200 && status < 300) return null
  return 'other'
}
