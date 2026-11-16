import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const bool = (v: string | undefined, def: boolean) => (v == null || v === '' ? def : /^(1|true|yes)$/i.test(v))

/** Working folder: Chrome profile, drafts, scan results, and downloads. */
export const HOME = process.env.INSTAGRAM_MCP_HOME || path.join(os.homedir(), '.instagram-mcp')
export const PROFILE_DIR = path.join(HOME, 'profile')
export const DATA_DIR = path.join(HOME, 'data')
export const DOWNLOAD_DIR = path.join(HOME, 'downloads')

export const cfg = {
  /** Run Chrome without a window. On servers a regular window inside Xvfb is safer. */
  headless: bool(process.env.INSTAGRAM_MCP_HEADLESS, false),
  /** Path to Chrome/Chromium. Empty means use `channel`. */
  chromePath: process.env.INSTAGRAM_MCP_CHROME_PATH || '',
  /** Playwright channel: "chrome" uses the installed Google Chrome. */
  channel: process.env.INSTAGRAM_MCP_CHROME_CHANNEL ?? 'chrome',
  host: process.env.INSTAGRAM_MCP_HOST || '127.0.0.1',
  port: Number(process.env.INSTAGRAM_MCP_PORT || 48300),
  /** Bearer token for HTTP mode. Required when host is not 127.0.0.1. */
  token: process.env.INSTAGRAM_MCP_TOKEN || '',
  /** Random delay between requests to Instagram. */
  minGapMs: Number(process.env.INSTAGRAM_MCP_MIN_GAP_MS || 3500),
  maxGapMs: Number(process.env.INSTAGRAM_MCP_MAX_GAP_MS || 8000),
  /** Calls that would wait longer than this are rejected immediately with `busy`. */
  maxWaitMs: 50_000,
  /** Daily limits for risky actions. */
  dailyLimits: {
    coldDm: Number(process.env.INSTAGRAM_MCP_LIMIT_COLD_DM || 15),
    like: Number(process.env.INSTAGRAM_MCP_LIMIT_LIKE || 150),
    follow: Number(process.env.INSTAGRAM_MCP_LIMIT_FOLLOW || 60),
    comment: Number(process.env.INSTAGRAM_MCP_LIMIT_COMMENT || 60),
  },
}

export const ensureDirs = () => {
  for (const d of [HOME, PROFILE_DIR, DATA_DIR, DOWNLOAD_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
}
