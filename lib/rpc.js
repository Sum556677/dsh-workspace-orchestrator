/**
 * Host side of the settings panel: same-origin JSON API.
 *
 * Mounted only when the profile runs a web server, so headless/tui profiles keep
 * working untouched.
 *
 * Auth model: the browser already authenticated against the DSH web server and the
 * panel only fetches same-origin; we additionally reject a cross-origin `Origin`,
 * require JSON bodies for writes, and keep every write explicit.
 *
 * Write safety: toggling a plugin flips `disabled` on the live loader entry only.
 * `Entry.update()` never calls `tree.write()`, so nothing is persisted to the
 * profile patch — a restart restores the composed state.
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { scanProfilePlugins } from './scan.js'
import { readMapping, defaultMappingPath, pathKey, isProtectedId } from './single-mode.mjs'

export const API_PREFIX = '/workspace-orchestrator/api'
const MAX_BODY = 64 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: { message } })
}

/** Reject a browser request that demonstrably comes from another origin. */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function routeOf(req) {
  const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  const pathname = url.pathname
  return pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) || '/' : pathname
}

/** Read a JSON body, bounded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { code: 'ETOOBIG' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Fill in what the static scan cannot see: rows contributed by a *bundle* patch do
 * not live in the profile's cordis.patch.yml, so the scan reports them without an id.
 */
function mergeLoaderRows(scanned, loaderRows) {
  const byName = new Map()
  for (const row of loaderRows) {
    if (!row?.name) continue
    if (!byName.has(row.name)) byName.set(row.name, [])
    byName.get(row.name).push(row)
  }
  return scanned.map((row) => {
    const live = (byName.get(row.name) ?? [])[0]
    return {
      id: row.id ?? live?.id ?? null,
      name: row.name ?? null,
      version: row.version ?? null,
      enabled: row.id ? row.enabled !== false : (live ? live.disabled !== true : row.enabled !== false),
      source: row.source ?? (live ? 'loader' : null),
    }
  })
}

async function buildState(bridge) {
  // The launcher's environment may describe a DIFFERENT profile than the one we are
  // running in (a test shell exports DSH_PROFILE_DIR=desktop). Prefer profileContext —
  // but keep DSH_HOME, or `--profile <name>` would resolve against ~/.dsh instead of the
  // home this process booted from.
  const scanOptions = { moduleDir: bridge.moduleDir }
  if (bridge.profileName) {
    scanOptions.env = { DSH_HOME: process.env.DSH_HOME ?? '' }
    scanOptions.argv = ['--profile', bridge.profileName]
    // An absolute profile directory is the least ambiguous form; it also covers a home
    // that is only discoverable from the live context.
    if (bridge.profileDir) scanOptions.argv.push(bridge.profileDir)
  } else {
    scanOptions.env = process.env
    scanOptions.argv = process.argv
  }
  const report = await scanProfilePlugins(scanOptions)
  return {
    profileDir: report.profileDir ?? null,
    runtimeVersion: report.runtimeVersion ?? null,
    profileSource: report.profileSource ?? null,
    diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics : [],
    plugins: mergeLoaderRows(report.plugins ?? [], bridge.loaderRows?.() ?? []),
    // The workspace-centred view needs the existing assignment to draw checkmarks.
    scope: readWorkspaceMapping(bridge.mappingPath),
    // The sidebar's workspaces, so the panel offers a dropdown instead of a text box.
    sidebar: readSidebarWorkspaces(bridge.dshHome ?? dshHome()),
    // Whether the runtime engine is alive, and why not when it is not.
    singleMode: readSingleModeStatus(bridge),
  }
}

/**
 * The blacklist engine's health, so the panel can render a real reason instead of a
 * bare "not running". A host that predates the bridge degrades to an explicit unknown.
 */
function readSingleModeStatus(bridge) {
  const unknown = {
    running: false,
    error: null,
    reason: 'host does not expose single-mode status (older build)',
    mappingPath: null,
    status: null,
    detail: null,
    workspace: null,
  }
  if (typeof bridge.singleModeStatus !== 'function') return unknown
  try {
    const status = bridge.singleModeStatus() ?? {}
    return {
      running: status.running === true,
      error: status.error ?? null,
      reason: status.reason ?? null,
      mappingPath: status.mappingPath ?? null,
      status: status.status ?? null,
      detail: status.detail ?? null,
      workspace: status.workspace ?? null,
      debug: status.debug === true,
    }
  } catch (error) {
    return { ...unknown, error: String(error?.message ?? error), reason: 'status probe threw' }
  }
}

async function buildInstances(bridge) {
  if (typeof bridge.listInstances !== 'function') return { count: 0, live: 0, instances: [] }
  const listed = await bridge.listInstances()
  return {
    count: listed?.count ?? 0,
    live: listed?.live ?? 0,
    instances: (listed?.instances ?? []).map((row) => ({
      profileName: row.profileName ?? null,
      pid: typeof row.pid === 'number' ? row.pid : null,
      workspacePath: row.workspacePath ?? null,
      url: row.url ?? null,
      port: typeof row.port === 'number' ? row.port : null,
      alive: row.alive === true,
      portReachable: typeof row.portReachable === 'boolean' ? row.portReachable : null,
    })),
  }
}

/**
 * The sidebar's workspace list, read from the DSH storage unit
 * `<home>/storages/workspace.json`.
 *
 * Schema confirmed against `@deepseek-ai/dsh-workspace` (domain `workspace`, version 2):
 *   global.workspaceIds   -> authoritative display order
 *   tables.workspaces[id] -> { path, title, sessionIds, createdAt, updatedAt }
 *
 * Read-only; a missing or unreadable file yields an empty list plus a reason and never
 * throws, so the panel still renders with manual entry available.
 * @param {string} home
 * @returns {{workspaces: Array<{id: string, path: string, title: string}>,
 *            file: string, error: string|null, available: boolean}}
 */
function readSidebarWorkspaces(home) {
  const file = join(home, 'storages', 'workspace.json')
  const empty = { workspaces: [], file, error: null, available: false }
  if (!existsSync(file)) return empty // DSH simply has no workspaces yet
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { ...empty, error: `workspace.json 无法解析：${error?.message ?? error}` }
  }
  const table = parsed?.tables?.workspaces
  if (!table || typeof table !== 'object') {
    return { ...empty, error: 'workspace.json 里没有 tables.workspaces（存储版本可能不同）' }
  }
  const order = Array.isArray(parsed?.global?.workspaceIds) ? parsed.global.workspaceIds : []
  // Stored display order first, then anything the order array missed.
  const ids = [
    ...order.filter((id) => typeof id === 'string' && table[id]),
    ...Object.keys(table).filter((id) => !order.includes(id)),
  ]
  const workspaces = []
  for (const id of ids) {
    const record = table[id]
    const path = typeof record?.path === 'string' ? record.path : ''
    if (!path) continue
    workspaces.push({
      id,
      path,
      title: typeof record?.title === 'string' && record.title.trim()
        ? record.title.trim()
        : (path.split(/[\\/]/).filter(Boolean).pop() ?? path),
    })
  }
  return { workspaces, file, error: null, available: true }
}

/** The DSH home this process runs against (same rule as single-mode.mjs). */
function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh')
}

/** POST /toggle — flip one live loader entry's disabled flag (memory only). */
async function toggle(bridge, body) {
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (!id) throw Object.assign(new Error('id is required'), { status: 400 })
  if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { status: 400 })
  if (typeof bridge.toggleRow !== 'function') throw Object.assign(new Error('loader is unavailable'), { status: 503 })
  return bridge.toggleRow(id, body.enabled)
}

/** POST /scope — bind a row (or package) to a workspace via the shared tool. */
async function setScope(bridge, body) {
  if (!bridge.scopeTool) throw Object.assign(new Error('scope tool is unavailable'), { status: 503 })
  const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
  if (!workspacePath) throw Object.assign(new Error('workspacePath is required'), { status: 400 })
  const args = { action: 'set', workspacePath }
  if (Array.isArray(body.pluginRowIds) && body.pluginRowIds.length > 0) args.pluginRowIds = body.pluginRowIds
  if (Array.isArray(body.pluginNames) && body.pluginNames.length > 0) args.pluginNames = body.pluginNames
  if (!args.pluginRowIds && !args.pluginNames) throw Object.assign(new Error('pluginRowIds or pluginNames is required'), { status: 400 })
  return bridge.scopeTool.execute(args)
}

/**
 * The workspace → blacklist assignment, for the panel's workspace-centred view.
 * Reads the same file the tool writes; never creates it.
 *
 * `disabledIds` is the blacklist. `ids` is kept as an alias for older panel builds.
 * `migrated` lists workspaces whose stored shape was the legacy v1 allowlist, so the
 * panel can say so instead of silently showing an empty blacklist.
 * @param {string} [mappingPath]
 */
function readWorkspaceMapping(mappingPath) {
  const file = mappingPath || defaultMappingPath()
  const mapping = readMapping(file)
  const workspaces = [...mapping.workspaces.entries()].map(([key, disabledIds]) => ({
    // Store one readable spelling: the tool keeps forward slashes in the file.
    path: key === '' ? '' : key,
    disabledIds,
    ids: disabledIds,
  }))
  return {
    mappingPath: file,
    workspaces,
    migrated: (mapping.migrated ?? []).map((path) => path),
    error: mapping.error ?? null,
  }
}

/**
 * POST /scope/toggle — add or remove ONE row id from a workspace's BLACKLIST.
 *
 * `enabled: false` (unticked in the panel) adds the id to `disabledPlugins`;
 * `enabled: true` (ticked) removes it. Plugins are on by default, so a workspace with an
 * empty blacklist simply runs everything the native profile loads.
 *
 * Deliberately not implemented as "read list, splice, call set": `set` replaces the whole
 * list, so a second panel or the agent editing the same workspace between our read and
 * write would lose that edit. This reads, modifies and writes the mapping in one pass
 * through the same reader/writer the tool uses, and only touches this workspace's entry.
 */
async function toggleScope(bridge, body) {
  const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
  if (!workspacePath) throw Object.assign(new Error('workspacePath is required'), { status: 400 })
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (!id) throw Object.assign(new Error('id (loader-entry id) is required'), { status: 400 })
  if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { status: 400 })
  // Disabling our own row would take the host half — and this API — down with it.
  if (!body.enabled && isProtectedId(id)) {
    throw Object.assign(new Error(`${id} 是编排器自身，禁止加入黑名单（否则会停掉管理它的引擎）`), { status: 409 })
  }
  const mappingPath = typeof body?.mappingPath === 'string' && body.mappingPath.trim()
    ? body.mappingPath.trim()
    : defaultMappingPath()

  const current = readMapping(mappingPath)
  if (current.error) throw Object.assign(new Error(`mapping unreadable: ${current.error}`), { status: 409 })
  // Work on a copy keyed by the original spelling, so unrelated workspaces keep their text.
  const workspaces = { ...(current.raw ?? {}) }
  const key = pathKey(workspacePath)
  const existingKey = Object.keys(workspaces).find((candidate) => pathKey(candidate) === key)

  // Adding to the blacklist needs a real loader row; a stale id would silently do nothing.
  if (!body.enabled) {
    let known = null
    try {
      const rows = bridge.loaderRows?.() ?? []
      if (rows.length > 0) known = new Set(rows.map((row) => row.id).filter(Boolean))
    } catch { /* best effort */ }
    if (known && !known.has(id)) {
      throw Object.assign(new Error(`没有 id 为 ${id} 的 loader 行（可能已被禁用或不在当前 profile）`), { status: 409 })
    }
  }

  const existingRecord = existingKey === undefined ? undefined : workspaces[existingKey]
  const list = Array.isArray(existingRecord)
    ? [...existingRecord] // legacy v1 allowlist — treated as an empty blacklist
    : Array.isArray(existingRecord?.disabledPlugins) ? [...existingRecord.disabledPlugins] : []
  const blacklisted = list.includes(id)
  // enabled=false => disable => add to the blacklist; enabled=true => re-enable => remove.
  const shouldBeBlacklisted = !body.enabled
  const next = shouldBeBlacklisted
    ? (blacklisted ? list : [...list, id])
    : list.filter((candidate) => candidate !== id)
  const changed = shouldBeBlacklisted ? !blacklisted : blacklisted

  if (existingKey !== undefined) delete workspaces[existingKey]
  if (next.length > 0) {
    // Keep an existing workspace's stored spelling; create a readable one when new.
    const spelling = existingKey ?? workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
    workspaces[spelling] = { disabledPlugins: next }
  }

  if (changed) {
    if (typeof bridge.writeMapping === 'function') {
      await bridge.writeMapping(mappingPath, workspaces)
    } else {
      const { writeMapping } = await import('./single-mode.mjs')
      writeMapping(mappingPath, workspaces)
    }
  }

  // Apply it to the live loader right away as well. Waiting for the next session/created
  // means the change would silently do nothing until a new session is opened, which is
  // exactly the "ticked/unticked but the plugin still runs" report.
  let applied = null
  if (changed && typeof bridge.reconcileSingleMode === 'function') {
    try {
      applied = await bridge.reconcileSingleMode(workspacePath)
    } catch (error) {
      applied = { changed: [], failed: [{ id: '(reconcile)', error: String(error?.message ?? error) }] }
    }
  }

  return {
    workspacePath: workspacePath.replace(/\\/g, '/').replace(/\/+$/, ''),
    id,
    enabled: body.enabled,
    changed,
    disabledPlugins: next,
    ids: next, // alias kept for older panel builds
    mappingPath,
    // What the live loader actually did, so the panel can report the truth.
    applied: applied
      ? { changed: applied.changed ?? [], failed: applied.failed ?? [] }
      : null,
  }
}

/** POST /instances/launch — start an isolated instance for the selected workspace. */
async function launchInstance(bridge, body) {
  if (typeof bridge.launchInstance !== 'function') throw Object.assign(new Error('orchestrator is unavailable'), { status: 503 })
  const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
  if (!workspacePath) throw Object.assign(new Error('workspacePath is required'), { status: 400 })
  try {
    return await bridge.launchInstance(workspacePath, { shareData: body?.shareData === true })
  } catch (error) {
    if (error?.code === 'EDSH_CONCURRENCY_LIMIT') error.status = 429
    if (error?.code === 'EDSH_INSTALL_NOT_FOUND') error.status = 503
    throw error
  }
}

async function stopInstance(bridge, body) {  if (typeof bridge.stopInstance !== 'function') throw Object.assign(new Error('orchestrator is unavailable'), { status: 503 })
  const target = body?.target
  if (typeof target !== 'string' && typeof target !== 'number') {
    throw Object.assign(new Error('target (profile name, workspace path, or pid) is required'), { status: 400 })
  }
  try {
    return await bridge.stopInstance(target)
  } catch (error) {
    if (error?.code === 'EDSH_INSTANCE_NOT_FOUND') error.status = 404
    throw error
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ moduleDir?: string, profileName?: string, loaderRows?: Function,
 *          toggleRow?: Function, scopeTool?: object, listInstances?: Function,
 *          stopInstance?: Function }} bridge
 */
export async function handleRequest(req, res, bridge = {}) {
  try {
    if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused')
    const route = routeOf(req)
    const method = req.method ?? 'GET'
    // Query string, for one-shot flags such as `?debug=1`.
    const query = (() => {
      try { return new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams } catch { return new URLSearchParams() }
    })()

    if (method === 'GET' && route === '/health') {
      return sendJson(res, 200, { ok: true, value: { alive: true } })
    }
    if (method === 'GET' && route === '/state') {
      return sendJson(res, 200, { ok: true, value: await buildState(bridge) })
    }
    if (method === 'GET' && route === '/instances') {
      return sendJson(res, 200, { ok: true, value: await buildInstances(bridge) })
    }

    if (method === 'POST') {
      const body = await readBody(req)
      if (route === '/toggle') return sendJson(res, 200, { ok: true, value: await toggle(bridge, body) })
      if (route === '/scope') return sendJson(res, 200, { ok: true, value: await setScope(bridge, body) })
      if (route === '/scope/toggle') {
        // `?debug=1` enables the verbose [single-mode DEBUG] trace for this action and
        // keeps it on for subsequent sessions until the host restarts.
        if (query.get('debug') === '1' && typeof bridge.setDebug === 'function') bridge.setDebug(true)
        return sendJson(res, 200, { ok: true, value: await toggleScope(bridge, body) })
      }
      if (route === '/scope/debug') {
        if (typeof bridge.setDebug !== 'function') return fail(res, 503, 'debug is unavailable')
        const on = body?.enabled !== false
        bridge.setDebug(on)
        return sendJson(res, 200, { ok: true, value: { debug: on } })
      }
      if (route === '/instances/stop') return sendJson(res, 200, { ok: true, value: await stopInstance(bridge, body) })
      if (route === '/instances/launch') return sendJson(res, 200, { ok: true, value: await launchInstance(bridge, body) })
      return fail(res, 404, `unknown endpoint ${route}`)
    }

    return fail(res, 405, 'method not allowed')
  } catch (error) {
    // The panel must always receive JSON it can render as an error.
    try {
      return fail(res, error?.status ?? 500, String(error?.message ?? error))
    } catch {
      return undefined
    }
  }
}
