/**
 * End-to-end settings, from the environment.
 *
 *   E2E_BASE        the GUI, e.g. http://127.0.0.1:5173 (Vite) or the deployed service
 *   E2E_TOKEN       a cluster-admin bearer token (or E2E_TOKEN_FILE, default ../.dev-token)
 *   E2E_BROWSER     a Chromium-family executable (default: Edge, then Chrome)
 *   E2E_HEADED=1    watch the browser
 *   E2E_KEEP=1      leave test resources behind for inspection
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const root = resolve(here, '..')
export const artifacts = join(root, 'artifacts')

export const base = (process.env.E2E_BASE ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
export const wsBase = base.replace(/^http/, 'ws')

function readToken() {
  if (process.env.E2E_TOKEN) return process.env.E2E_TOKEN.trim()
  const file = process.env.E2E_TOKEN_FILE ?? resolve(root, '..', '..', '.dev-token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  throw new Error('set E2E_TOKEN or E2E_TOKEN_FILE to a cluster-admin bearer token')
}
export const token = readToken()

export const browserPath =
  process.env.E2E_BROWSER ??
  ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((p) => existsSync(p))

export const headed = process.env.E2E_HEADED === '1'
export const keep = process.env.E2E_KEEP === '1'

/** A short random suffix so parallel and repeated runs never collide. */
export function suffix() {
  return Math.random().toString(36).slice(2, 7)
}
