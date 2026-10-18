#!/usr/bin/env node
// Verify the workspace-centred settings API against a throwaway mapping file.
//
//   node lib/orchestrator-core/verify-scope-rpc.mjs [--home D:\tmp\dsh-test]
//
// Exercises the real HTTP handler (rpc.js handleRequest) — same code the panel talks to —
// with a fake loader, so no DSH process is started and no real profile is touched.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { handleRequest, API_PREFIX } from '../rpc.js'

const argv = process.argv.slice(2)
const argHome = (() => {
  const i = argv.indexOf('--home')
  if (i >= 0) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--home='))
  return eq ? eq.slice('--home='.length) : ''
})()

const HOME = resolve(argHome || process.env.DSH_HOME || join(tmpdir(), 'scope-rpc-test'))
const PROFILE = 'web'

function assertDisposable(home) {
  const real = resolve(homedir(), '.dsh').toLowerCase()
  const target = resolve(home).toLowerCase()
  if (target === real) throw new Error(`拒绝在真实 DSH_HOME 上运行测试：${home}`)
  if (!/dsh-test|scope-rpc-test/i.test(target)) {
    throw new Error(`测试目录看起来不是一次性目录，已拒绝：${home}（路径里需含 dsh-test 或 scope-rpc-test）`)
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** A profile on disk so the scan has something to report. */
function writeFixture() {
  const profileDir = join(HOME, 'profiles', PROFILE)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.patch.yml'),
    '- insert:\n    - id: dsh-novel-writer\n      name: dsh-novel-writer\n    - id: dsh-code-helper\n      name: dsh-code-helper\n')
  for (const name of ['dsh-novel-writer', 'dsh-code-helper']) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }, null, 2))
    writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n')
  }
  return profileDir
}

/**
 * The sidebar workspace storage, in the shape `@deepseek-ai/dsh-workspace` writes
 * (domain `workspace` v2: global.workspaceIds = display order, tables.workspaces records).
 */
function writeSidebarFixture() {
  const dir = join(HOME, 'storages')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'ws-default',
      workspaceIds: ['ws-web', 'ws-plugin', 'ws-default'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        // Inserted out of display order on purpose: global.workspaceIds must win.
        'ws-default': { path: 'C:\\Users\\someone\\Projects\\default-workspace', title: 'default-workspace', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        'ws-plugin': { path: 'D:\\Agent_workspaces\\DSH_plugin', title: 'DSH_plugin', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        'ws-web': { path: 'D:\\Agent_workspaces\\DSH_web', title: 'DSH_web', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      },
    },
  }, null, 2))
}

async function main() {
  assertDisposable(HOME)
  if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true })
  const profileDir = writeFixture()
  writeSidebarFixture()
  const mappingPath = join(HOME, 'workspace-orchestrator', 'single-mode.json')
  // `scanProfilePlugins` reads DSH_HOME from process.env, and this shell may point at the
  // real home. Re-point the process so the scan resolves the fixture, not C:\Users\...\.dsh.
  process.env.DSH_HOME = HOME
  console.log(`\n[fixture] DSH_HOME = ${HOME}`)
  console.log(`[mapping] ${mappingPath}\n`)

  // Live rows as the host would report them (ids come from the loader in a real run).
  const rows = [
    { id: 'dsh-novel-writer', name: 'dsh-novel-writer', disabled: false },
    { id: 'dsh-code-helper', name: 'dsh-code-helper', disabled: false },
  ]
  const bridge = {
    moduleDir: import.meta.dirname,
    profileName: PROFILE,
    loaderRows: () => rows,
    mappingPath,
    dshHome: HOME,
  }

  const server = createServer((req, res) => handleRequest(req, res, bridge))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
  void profileDir

  const call = async (path, body) => {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const res = await fetch(base + path, init)
    let json = null
    try { json = await res.json() } catch { /* non-JSON */ }
    return { status: res.status, json }
  }
  const readMapping = () => {
    if (!existsSync(mappingPath)) return null
    return JSON.parse(readFileSync(mappingPath, 'utf8'))
  }

  try {
    // ---- initial state ---------------------------------------------------
    const state = await call('/state')
    check('GET /state ok', state.status === 200 && state.json?.ok === true, `status=${state.status}`)
    check('/state exposes the workspace mapping', state.json?.value?.scope?.mappingPath === mappingPath
      && Array.isArray(state.json?.value?.scope?.workspaces), JSON.stringify(state.json?.value?.scope))
    check('plugins are listed for the checklist',
      (state.json?.value?.plugins ?? []).map((p) => p.name).sort().join(',') === 'dsh-code-helper,dsh-novel-writer',
      JSON.stringify((state.json?.value?.plugins ?? []).map((p) => p.name)))
    // Regression guard: the panel must resolve the profile from DSH_HOME even when the
    // launcher's env points elsewhere (an earlier version blanked env and lost the home).
    check('/state resolved the profile from DSH_HOME',
      state.json?.value?.profileDir === join(HOME, 'profiles', PROFILE),
      String(state.json?.value?.profileDir))

    // ---- sidebar workspaces (the dropdown's source) ----------------------
    const sidebar = state.json?.value?.sidebar ?? {}
    check('/state exposes the sidebar workspace list', sidebar.available === true, JSON.stringify(sidebar.error))
    check('sidebar workspaces parsed with title + path',
      Array.isArray(sidebar.workspaces) && sidebar.workspaces.length === 3, JSON.stringify(sidebar.workspaces))
    check('sidebar honours the stored display order',
      JSON.stringify((sidebar.workspaces ?? []).map((w) => w.title)) === '["DSH_web","DSH_plugin","default-workspace"]',
      JSON.stringify((sidebar.workspaces ?? []).map((w) => w.title)))
    check('sidebar entries carry the raw path',
      sidebar.workspaces?.find((w) => w.title === 'DSH_plugin')?.path === 'D:\\Agent_workspaces\\DSH_plugin')

    // ---- BLACKLIST semantics (v0.3.0) ------------------------------------
    // Unticking a box must ADD to the blacklist; plugins are on by default.
    const WS = 'D:/workspace/novels'
    const off1 = await call('/scope/toggle', { workspacePath: WS, id: 'dsh-novel-writer', enabled: false })
    check('unticking adds the id to the blacklist', off1.status === 200 && off1.json?.value?.changed === true,
      JSON.stringify(off1.json?.error ?? ''))
    let file = readMapping()
    check('mapping file is version 2', file !== null && file.version === 2, String(file?.version))
    check('entry stores disabledPlugins (not a bare array)',
      JSON.stringify(file?.workspaces?.[WS]) === '{"disabledPlugins":["dsh-novel-writer"]}',
      JSON.stringify(file?.workspaces))

    // A workspace with no blacklist entry runs everything — the default.
    check('an untouched workspace is not written at all', !Object.hasOwn(file?.workspaces ?? {}, 'D:/workspace/untouched'))

    // ---- untick a second plugin ------------------------------------------
    await call('/scope/toggle', { workspacePath: WS, id: 'dsh-code-helper', enabled: false })
    file = readMapping()
    check('second untick appends to the blacklist',
      JSON.stringify(file?.workspaces?.[WS]?.disabledPlugins) === '["dsh-novel-writer","dsh-code-helper"]',
      JSON.stringify(file?.workspaces?.[WS]))

    // ---- idempotent ------------------------------------------------------
    const again = await call('/scope/toggle', { workspacePath: WS, id: 'dsh-code-helper', enabled: false })
    check('re-unticking reports changed=false', again.json?.value?.changed === false)
    check('re-unticking does not duplicate',
      JSON.parse(readFileSync(mappingPath, 'utf8')).workspaces[WS].disabledPlugins.length === 2)

    // ---- state exposes the blacklist for the checkboxes -------------------
    const state2 = await call('/state')
    const entry = (state2.json?.value?.scope?.workspaces ?? []).find((w) => w.path === 'd:/workspace/novels')
    check('/state reports disabledIds for the workspace',
      JSON.stringify(entry?.disabledIds) === '["dsh-novel-writer","dsh-code-helper"]',
      JSON.stringify(state2.json?.value?.scope?.workspaces))

    // ---- re-ticking removes from the blacklist ---------------------------
    const on1 = await call('/scope/toggle', { workspacePath: WS, id: 'dsh-novel-writer', enabled: true })
    check('ticking removes from the blacklist', on1.json?.value?.changed === true)
    file = readMapping()
    check('the other id survives re-tick',
      JSON.stringify(file?.workspaces?.[WS]?.disabledPlugins) === '["dsh-code-helper"]',
      JSON.stringify(file?.workspaces?.[WS]))

    // ---- a second workspace is independent -------------------------------
    await call('/scope/toggle', { workspacePath: 'D:/workspace/code', id: 'dsh-code-helper', enabled: false })
    file = readMapping()
    check('second workspace blacklist added independently',
      JSON.stringify(file?.workspaces?.['D:/workspace/code']?.disabledPlugins) === '["dsh-code-helper"]'
      && file?.workspaces?.[WS]?.disabledPlugins?.length === 1,
      JSON.stringify(file?.workspaces))

    // ---- case-insensitive workspace identity -----------------------------
    await call('/scope/toggle', { workspacePath: 'D:\\WORKSPACE\\Novels', id: 'dsh-novel-writer', enabled: false })
    file = readMapping()
    const keys = Object.keys(file?.workspaces ?? {})
    check('same workspace under different casing is not duplicated',
      keys.filter((k) => k.toLowerCase() === 'd:/workspace/novels').length === 1, JSON.stringify(keys))

    // ---- emptying the blacklist drops the entry --------------------------
    await call('/scope/toggle', { workspacePath: WS, id: 'dsh-code-helper', enabled: true })
    await call('/scope/toggle', { workspacePath: WS, id: 'dsh-novel-writer', enabled: true })
    file = readMapping()
    check('emptying a blacklist removes its entry',
      !Object.keys(file?.workspaces ?? {}).some((k) => k.toLowerCase() === 'd:/workspace/novels'),
      JSON.stringify(file?.workspaces))

    // ---- legacy v1 allowlist is reported, not silently reinterpreted -----
    writeFileSync(mappingPath, JSON.stringify({
      version: 1,
      workspaces: { 'D:/workspace/legacy': ['dsh-novel-writer'] },
    }, null, 2))
    const legacy = await call('/state')
    check('legacy allowlist entry is flagged as migrated',
      JSON.stringify(legacy.json?.value?.scope?.migrated) === '["D:/workspace/legacy"]',
      JSON.stringify(legacy.json?.value?.scope?.migrated))
    check('legacy allowlist reads as an empty blacklist (all enabled)',
      JSON.stringify((legacy.json?.value?.scope?.workspaces ?? []).find((w) => w.path === 'd:/workspace/legacy')?.disabledIds) === '[]',
      JSON.stringify(legacy.json?.value?.scope?.workspaces))
    rmSync(mappingPath, { force: true })

    // ---- guards ----------------------------------------------------------
    check('missing workspacePath is 400', (await call('/scope/toggle', { id: 'dsh-novel-writer', enabled: false })).status === 400)
    check('missing id is 400', (await call('/scope/toggle', { workspacePath: 'D:/x', enabled: false })).status === 400)
    check('non-boolean enabled is 400',
      (await call('/scope/toggle', { workspacePath: 'D:/x', id: 'dsh-novel-writer', enabled: 'yes' })).status === 400)
    // Blacklisting a row that does not exist would silently do nothing, so it is refused.
    check('unknown loader id is refused (409)',
      (await call('/scope/toggle', { workspacePath: 'D:/x', id: 'not-a-row', enabled: false })).status === 409)
    check('refused write leaves the mapping untouched',
      !existsSync(mappingPath) || !Object.keys(readMapping().workspaces ?? {}).includes('D:/x'))

    // ---- launch endpoint is reachable ------------------------------------
    const launch = await call('/instances/launch', { workspacePath: 'D:/workspace/novels' })
    check('launch endpoint exists (503 without an orchestrator bridge), not 404',
      launch.status === 503, `status=${launch.status}`)

    // ---- a broken sidebar file must not break /state ---------------------
    const sidebarFile = join(HOME, 'storages', 'workspace.json')
    writeFileSync(sidebarFile, '{ this is not json')
    const broken = await call('/state')
    check('/state still renders when workspace.json is corrupt', broken.status === 200 && broken.json?.ok === true,
      `status=${broken.status}`)
    check('corrupt sidebar is reported, not thrown', typeof broken.json?.value?.sidebar?.error === 'string'
      && broken.json.value.sidebar.available === false, JSON.stringify(broken.json?.value?.sidebar?.error))
    check('plugin list survives a corrupt sidebar', (broken.json?.value?.plugins ?? []).length === 2)

    rmSync(sidebarFile, { force: true })
    const absent = await call('/state')
    check('/state treats a missing workspace.json as an empty list', absent.status === 200
      && absent.json?.value?.sidebar?.available === false && Array.isArray(absent.json?.value?.sidebar?.workspaces)
      && absent.json.value.sidebar.workspaces.length === 0)
  } finally {
    await new Promise((done) => server.close(done))
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    process.exitCode = 1
  }
  void profileDir
}

main().catch((error) => {
  console.error(`\n[verify-scope-rpc] crashed: ${error?.stack ?? error}`)
  process.exitCode = 1
})
