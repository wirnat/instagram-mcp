import type { IgSession } from '../ig/client.js'

export type Risk = 'read' | 'write' | 'action'

export type Param = {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  required?: boolean
}

export type Tool = {
  name: string
  description: string
  params: Param[]
  risk: Risk
  /** false for tools that never touch Instagram and therefore skip the queue. */
  paced?: boolean
  handler: (args: Record<string, any>, ig: IgSession) => Promise<unknown>
}

const tools = new Map<string, Tool>()

export const defineTool = (t: Tool): void => {
  if (tools.has(t.name)) throw new Error(`Tool ganda: ${t.name}`)
  tools.set(t.name, t)
}

export const allTools = (): Tool[] => [...tools.values()]

/** Write tools that change the Instagram account itself, as opposed to local data on the server. */
const ACCOUNT_WRITES = new Set(['dm_mark_seen', 'ig_post_edit', 'ig_post_delete', 'note_set', 'profile_update', 'draft_schedule'])

/**
 * True when a tool changes the Instagram account (sends, likes, follows, comments, publishes, edits).
 * Background scans are marked `action` because they run long jobs, but they only read, so they are excluded.
 */
export const changesAccount = (t: Tool): boolean =>
  (t.risk === 'action' && !t.name.endsWith('_scan')) || ACCOUNT_WRITES.has(t.name)
export const getTool = (name: string): Tool | undefined => tools.get(name)

const INSTANT: Param = {
  name: 'instant',
  type: 'boolean',
  description: 'True to skip the paced queue. Use only when the user asks for an immediate action.',
}

/** JSON Schema for the MCP tool list. */
export const inputSchema = (t: Tool) => {
  const params = t.paced === false ? t.params : [...t.params, INSTANT]
  return {
    type: 'object' as const,
    properties: Object.fromEntries(params.map(p => [p.name, { type: p.type, description: p.description }])),
    required: params.filter(p => p.required).map(p => p.name),
  }
}

export const str = (v: unknown): string | undefined => {
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}
export const need = (v: unknown, tool: string, name: string): string => {
  const s = str(v)
  if (!s) throw new Error(`${tool} requires \`${name}\``)
  return s
}
export const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, min), max) : def
}
export const flag = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1'
export const cleanUsername = (v: unknown): string | undefined => str(v)?.replace(/^@/, '')
