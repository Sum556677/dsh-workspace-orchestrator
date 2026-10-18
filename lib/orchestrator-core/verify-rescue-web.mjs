#!/usr/bin/env node
// Verify the P3 rescue web panel end-to-end against a throwaway DSH_HOME.
// No DSH host is started: the panel is a standalone HTTP server over fixture files.
//
//   node lib/orchestrator-core/verify-rescue-web.mjs [--home D:\tmp\dsh-test]
//
// Safety: refuses to run when the resolved home is a real harness home (~/.dsh or
// whatever DSH_HOME points at unless it is explicitly under the temp root).
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { startRescueWeb } from '../rescue-web.js'

const argv = process.argv.slice(2)
const argHome = (() => {
  const i = argv.indexOf('--home')
  if (i >= 0) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--home='))
  return eq ? eq.slice('--home='.length) : ''
})()

const HOME = resolve(argHome || process.env.DSH_HOME || join(tmpdir(), 'rescue-web-test'))
const PROFILE = 'web'

/** Hard guard: never write into the user's real harness home. */
function assertDisposable(home) {
  const real = resolve(homedir(), '.dsh').toLowerCase()
  const target = resolve(home).toLowerCase()
  if (target === real) throw new Error(`拒绝在真实 DSH_HOME 上运行测试：${home}`)
  // The directory must announce itself as a test root, either by being passed with
  // --home explicitly or by living in DSH_HOME and carrying a disposable name.
  const named = /dsh-test|rescue-web-test/i.test(target)
  if (!argHome && !named) {
    throw new Error(`DSH_HOME=${process.env.DSH_HOME ?? '(unset)'} 看起来不是一次性测试目录；请显式传 --home <测试目录>。`)
  }
  if (!named) {
    throw new Error(`测试目录看起来不是一次性目录，已拒绝：${home}（路径里需含 dsh-test 或 rescue-web-test）`)
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function writePlugin(profileDir, name, version, source) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }, null, 2))
  writeFileSync(join(dir, 'index.js'), source)
  return dir
}

async function api(base, token, path, body) {
  const init = { headers: { 'x-rescue-token': token, accept: 'application/json' } }
  if (body !== undefined) {
    init.method = 'POST'
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(base + path, init)
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json }
}

async function main() {
  assertDisposable(HOME)
  if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true })
  const profileDir = join(HOME, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  console.log(`\n[fixture] DSH_HOME = ${HOME}\n`)

  // ---- fixture -----------------------------------------------------------
  // Two third-party plugins mounted through nested `- insert:` rows, one through a
  // nested insert row that also carries `inject`, and one as a top-level override row.
  // A fifth plugin is installed but never registered (the patch cannot start it).
  // This mirrors the real shape in cordis.patch.yml: `- insert:` then 4-space `- id:`.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:
    - id: dsh-plugin-alpha
      name: dsh-plugin-alpha
    - id: dsh-plugin-beta
      name: dsh-plugin-beta
    - insert:
        - id: dsh-plugin-gamma
          name: dsh-plugin-gamma
- id: dsh-plugin-delta
  name: dsh-plugin-delta
`)
  writePlugin(profileDir, 'dsh-plugin-alpha', '1.2.3',
    "export const name = 'alpha'\nexport const inject = ['alpha-service']\nexport function apply(ctx) { ctx.provide('alpha-service') }\n")
  writePlugin(profileDir, 'dsh-plugin-beta', '0.4.0',
    "export const name = 'beta'\nexport const inject = ['alpha-service']\nexport function apply(ctx) {}\n")
  writePlugin(profileDir, 'dsh-plugin-gamma', '3.1.0',
    "export const name = 'gamma'\nexport const inject = ['gamma-service']\nexport function apply(ctx) { ctx.provide('gamma-service') }\n")
  writePlugin(profileDir, 'dsh-plugin-delta', '2.0.0',
    "export const name = 'delta'\nexport const inject = ['delta-service']\nexport function apply(ctx) { ctx.provide('delta-service') }\n")
  writePlugin(profileDir, 'dsh-plugin-unregistered', '9.9.9', "export const name = 'unregistered'\n")
  // An official package must never be offered for quarantine.
  writePlugin(profileDir, '@deepseek-ai/dsh-core', '0.2.0-rc.2', 'export const name = "core"\n')

  // ---- bundle fixture -----------------------------------------------------
  // A third-party bundle selected in dsh.profile.bundles whose own patch inserts a
  // row with an id that is NOT the package name (the real dsh-webds-bridge-host shape
  // is id == name, but ids are arbitrary). This is the case the old panel could not
  // see at all: there is nothing to move, only config to edit.
  writePlugin(profileDir, 'dsh-bundle-crash', '5.0.0', "export const name = 'bundle-crash'\nexport function apply(ctx) {}\n")
  // A real bundle declares its patch via dsh.bundle.patch; that declaration is what the
  // panel follows to find the entry ids it must disable.
  writeFileSync(join(profileDir, 'node_modules', 'dsh-bundle-crash', 'package.json'), JSON.stringify({
    name: 'dsh-bundle-crash', version: '5.0.0', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(profileDir, 'node_modules', 'dsh-bundle-crash', 'cordis.patch.yml'),
    '- insert:\n    - id: crash-bundle-entry\n      name: dsh-bundle-crash\n')
  const manifestPath = join(profileDir, 'package.json')
  const manifestBefore = JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-bundle-crash': '5.0.0', 'dsh-plugin-alpha': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-bundle-crash'] } },
  }, null, 2) + '\n'
  writeFileSync(manifestPath, manifestBefore)

  // A second bundle that is selected but has NO node_modules folder and no patch of its
  // own: it must still be listed (with the id fallback) or rescue silently misses it.
  const manifestNoFolder = JSON.parse(manifestBefore)
  manifestNoFolder.dsh.profile.bundles.push('dsh-bundle-missing')
  writeFileSync(manifestPath, JSON.stringify(manifestNoFolder, null, 2) + '\n')
  const manifestBeforeAll = readFileSync(manifestPath, 'utf8')

  const patchBefore = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const panel = await startRescueWeb({ home: HOME, profileName: PROFILE, port: 0 })
  const { url, token } = panel
  const base = `http://127.0.0.1:${panel.port}`
  console.log(`[panel] ${url}\n`)

  try {
    // ---- page ------------------------------------------------------------
    const page = await fetch(base + '/')
    const pageText = await page.text()
    check('GET / returns HTML', page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? ''))
    check('page has no external CDN/resource', !/(src|href)=["']https?:/i.test(pageText) && !/cdn\./i.test(pageText))
    check('page embeds the panel token', pageText.includes(token))

    // ---- state -----------------------------------------------------------
    const state = await api(base, token, '/api/state')
    check('GET /api/state ok', state.status === 200 && state.json?.ok === true, `status=${state.status}`)
    const value = state.json?.value ?? {}
    const names = (value.plugins ?? []).map((p) => p.name)
    check('lists third-party plugins', ['dsh-plugin-alpha', 'dsh-plugin-beta', 'dsh-plugin-delta'].every((n) => names.includes(n)), names.join(', '))
    check('excludes official @deepseek-ai packages', !names.some((n) => n.startsWith('@deepseek-ai/')))
    check('flags installed-but-unregistered plugin', (value.plugins ?? []).some((p) => p.name === 'dsh-plugin-unregistered' && p.registered === false))
    // The page must show red/yellow scan output. `dependency-cycle` is the one code this
    // fixture triggers on purpose (alpha `apply()` mentions its own service name, which the
    // static extractor counts as both provide and inject) — enough to prove wiring end-to-end.
    check('conflict scan produced findings for the page', value.errorCount >= 1 && value.conflicts.every((c) => c.level === 'error'),
      `errors=${value.errorCount}, codes=${value.conflicts.map((c) => c.code).join('|')}`)
    check('bad token is rejected', (await api(base, 'nope', '/api/state')).status === 403)
    check('state requires GET', (await api(base, token, '/api/state', {})).status === 405)

    // ---- quarantine ------------------------------------------------------
    const before = join(profileDir, 'node_modules', 'dsh-plugin-alpha')
    const q = await api(base, token, '/api/quarantine', { packageName: 'dsh-plugin-alpha' })
    check('POST /api/quarantine ok', q.status === 200 && q.json?.ok === true, JSON.stringify(q.json?.error ?? ''))
    const slug = q.json?.value?.slug
    check('package moved out of node_modules', !existsSync(before))
    check('payload kept in disabled/<pkg>@<ver>/payload', Boolean(slug) && existsSync(join(HOME, 'workspace-orchestrator', 'disabled', slug, 'payload', 'index.js')), String(slug))
    const patchAfter = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    check('patch got a disabled row', /disabled:\s*true/.test(patchAfter) && patchAfter.includes('dsh-plugin-alpha'))
    check('patch backed up before edit', readdirSync(profileDir).some((f) => f.startsWith('cordis.patch.yml.bak-')))

    const mid = (await api(base, token, '/api/state')).json.value
    const alpha = mid.plugins.find((p) => p.name === 'dsh-plugin-alpha')
    check('state shows plugin as quarantined', alpha?.quarantined === true)
    check('quarantine entry is restorable', mid.disabled.some((d) => d.slug === slug && d.payloadPresent === true))
    check('quarantine rejects path traversal', (await api(base, token, '/api/quarantine', { packageName: '../../x' })).status === 400)
    check('quarantine rejects unknown package', (await api(base, token, '/api/quarantine', { packageName: 'dsh-plugin-nope' })).status === 404)
    check('double quarantine is refused', (await api(base, token, '/api/quarantine', { packageName: 'dsh-plugin-alpha' })).status === 404)

    // ---- restore ---------------------------------------------------------
    const r = await api(base, token, '/api/restore', { slug })
    check('POST /api/restore ok', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json?.error ?? ''))
    check('package moved back', existsSync(join(before, 'index.js')))
    check('restore reports patch reverted', r.json?.value?.revertedPatch === true && !r.json?.value?.patchNote)
    check('patch restored byte-for-byte', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchBefore)
    check('quarantine dir cleaned up', !existsSync(join(HOME, 'workspace-orchestrator', 'disabled', slug)))
    check('restore rejects traversal slug', (await api(base, token, '/api/restore', { slug: '../web' })).status === 400)
    check('restore of unknown slug is 404', (await api(base, token, '/api/restore', { slug: 'nope@1.0.0' })).status === 404)

    // ---- top-level override row (delta) ----------------------------------
    const q2 = await api(base, token, '/api/quarantine', { packageName: 'dsh-plugin-delta' })
    check('quarantine works for a top-level row', q2.status === 200)
    const r2 = await api(base, token, '/api/restore', { slug: q2.json?.value?.slug })
    check('delta restore reverts patch exactly', r2.json?.value?.revertedPatch === true
      && readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchBefore)

    // ---- recovery when the patch was edited between move and restore -----
    const q3 = await api(base, token, '/api/quarantine', { packageName: 'dsh-plugin-beta' })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') + '# user comment added later\n')
    const r3 = await api(base, token, '/api/restore', { slug: q3.json?.value?.slug })
    const patch3 = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    check('restore still cleans the disable row after later edits',
      r3.json?.value?.revertedPatch === true && !/disabled:\s*true/.test(patch3), patch3.replace(/\n/g, '\\n'))
    check('restore preserves the later user comment', patch3.includes('# user comment added later'))
    check('fixture patch back at original + comment', patch3 === patchBefore + '# user comment added later\n')

    // ---- tampered record must not move files outside profiles ------------
    const evilSlug = 'evil@1.0.0'
    const evilDir = join(HOME, 'workspace-orchestrator', 'disabled', evilSlug)
    mkdirSync(join(evilDir, 'payload'), { recursive: true })
    writeFileSync(join(evilDir, 'quarantine.json'), JSON.stringify({
      packageName: 'evil', version: '1.0.0', profile: PROFILE,
      originalPath: join(HOME, 'outside-marker'), rows: [], appended: '', at: new Date().toISOString(),
    }))
    const r4 = await api(base, token, '/api/restore', { slug: evilSlug })
    check('tampered record cannot move files outside profiles/', r4.status === 409 && !existsSync(join(HOME, 'outside-marker')))

    // ===== bundle rescue ==================================================
    // The package round-trips above appended and removed rows, so the bundle section
    // snapshots the patch as it stands now rather than the original fixture.
    const patchBeforeBundle = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const bState = (await api(base, token, '/api/state')).json.value
    const crashBundle = bState.plugins.find((p) => p.name === 'dsh-bundle-crash')
    const missingBundle = bState.plugins.find((p) => p.name === 'dsh-bundle-missing')
    check('bundle from dsh.profile.bundles is listed', Boolean(crashBundle))
    check('bundle is marked as not movable', crashBundle?.kind === 'bundle' && crashBundle?.movable === false)
    check('bundle entry id comes from its own patch, not the package name',
      JSON.stringify(crashBundle?.entryIds) === JSON.stringify(['crash-bundle-entry']), JSON.stringify(crashBundle?.entryIds))
    check('bundle with no folder is still listed', Boolean(missingBundle) && missingBundle.hasFolder === false)
    check('folderless bundle flags an id fallback', missingBundle?.idGuess === true)
    check('state exposes the bundle list', Array.isArray(bState.bundles) && bState.bundles.includes('dsh-bundle-crash'))

    // disable only: patch rows, manifest untouched
    const bd = await api(base, token, '/api/bundle-disable', { packageName: 'dsh-bundle-crash' })
    check('bundle disable ok', bd.status === 200 && bd.json?.ok === true, JSON.stringify(bd.json?.error ?? ''))
    const patchBundle = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    check('bundle disable appended the real entry id',
      patchBundle.includes('- id: crash-bundle-entry') && patchBundle.includes('  disabled: true'), patchBundle.replace(/\n/g, '\\n'))
    check('bundle disable appended two rows', patchBundle === patchBeforeBundle + '- id: crash-bundle-entry\n  disabled: true\n')
    check('bundle disable backed up the patch', readdirSync(profileDir).some((f) => f.startsWith('cordis.patch.yml.bak-')))
    check('disable-only leaves package.json untouched', readFileSync(manifestPath, 'utf8') === manifestBeforeAll)
    const bAfter = (await api(base, token, '/api/state')).json.value
    check('bundle shows as disabled after patch row', bAfter.plugins.find((p) => p.name === 'dsh-bundle-crash')?.enabled === false)

    // restore from the plugin list path
    const bRestore = await api(base, token, '/api/bundle-restore', { slug: bd.json?.value?.slug })
    check('bundle restore ok', bRestore.status === 200 && bRestore.json?.value?.revertedPatch === true)
    check('bundle restore reverts patch exactly', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchBeforeBundle)

    // uninstall: patch rows + manifest removal, both backed up
    const bu = await api(base, token, '/api/bundle-disable', { packageName: 'dsh-bundle-crash', uninstall: true })
    check('bundle uninstall ok', bu.status === 200 && bu.json?.value?.uninstalled === true)
    const manifestAfter = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check('uninstall removed it from dsh.profile.bundles',
      !manifestAfter.dsh.profile.bundles.includes('dsh-bundle-crash'), JSON.stringify(manifestAfter.dsh.profile.bundles))
    check('uninstall removed it from dependencies', !Object.hasOwn(manifestAfter.dependencies ?? {}, 'dsh-bundle-crash'))
    check('uninstall kept unrelated entries', manifestAfter.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')
      && manifestAfter.dependencies['dsh-plugin-alpha'] === '1.2.3')
    check('uninstall backed up package.json', readdirSync(profileDir).some((f) => f.startsWith('package.json.bak-')))
    const buSlug = bu.json?.value?.slug
    const buRestore = await api(base, token, '/api/bundle-restore', { slug: buSlug })
    check('uninstall is restorable', buRestore.json?.value?.restoredManifest === true)
    const manifestRestored = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check('manifest restored to the original bundle order',
      JSON.stringify(manifestRestored.dsh.profile.bundles) === JSON.stringify(manifestBeforeAll && JSON.parse(manifestBeforeAll).dsh.profile.bundles),
      JSON.stringify(manifestRestored.dsh.profile.bundles))
    check('dependency restored with its original spec', manifestRestored.dependencies['dsh-bundle-crash'] === '5.0.0')
    check('bundle restore reverted the patch too', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchBeforeBundle)

    // guards
    check('bundle disable rejects an unknown bundle',
      (await api(base, token, '/api/bundle-disable', { packageName: 'dsh-bundle-nope' })).status === 404)
    check('bundle disable rejects path traversal',
      (await api(base, token, '/api/bundle-disable', { packageName: '../package' })).status === 400)
    check('package restore refuses a bundle record', (await api(base, token, '/api/restore', { slug: buSlug ?? 'x' })).status === 404)
    check('official bundles are never listed for rescue',
      !bState.plugins.some((p) => String(p.name).startsWith('@deepseek-ai/')))

    // A failed "uninstall" must not leave the patch half-edited.
    // `dsh-bundle-missing` has no dependency entry, only a bundles entry: that is a
    // legitimate uninstall target, so it must succeed.
    const patchGuard = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    void patchGuard
    const g = await api(base, token, '/api/bundle-disable', { packageName: 'dsh-bundle-missing', uninstall: true })
    check('uninstall succeeds when only the bundles entry exists', g.status === 200 && g.json?.ok === true,
      JSON.stringify(g.json?.error ?? ''))
    const guardAfter = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check('uninstall removed the manifest entry it could see',
      !guardAfter.dsh.profile.bundles.includes('dsh-bundle-missing'))
    check('uninstall did not corrupt unrelated dependencies',
      guardAfter.dependencies['dsh-plugin-alpha'] === '1.2.3')
    // An uninstall of something absent from BOTH manifest lists must fail without editing
    // anything. `dsh-plugin-alpha` is a dependency but not a bundle; put it in neither list
    // by removing nothing — instead use a name that is in no list at all.
    const patchBeforeMissing = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const manifestBeforeMissing = readFileSync(manifestPath, 'utf8')
    const missing = await api(base, token, '/api/bundle-disable', { packageName: 'dsh-bundle-missing', uninstall: true })
    check('uninstall refuses a package absent from both manifest lists', missing.status === 404,
      `status=${missing.status}`)
    check('refused uninstall leaves the patch untouched',
      readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchBeforeMissing)
    check('refused uninstall leaves the manifest untouched',
      readFileSync(manifestPath, 'utf8') === manifestBeforeMissing)

    // ---- node_modules path still works after the bundle work (regression) --
    const patchBeforeGamma = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const q9 = await api(base, token, '/api/quarantine', { packageName: 'dsh-plugin-gamma' })
    const r9 = await api(base, token, '/api/restore', { slug: q9.json?.value?.slug })
    check('node_modules quarantine/restore still round-trips after bundle support',
      q9.status === 200 && r9.json?.value?.revertedPatch === true
      && readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') === patchBeforeGamma,
      `quarantined=${q9.status}, reverted=${r9.json?.value?.revertedPatch}`)
    check('node_modules plugin folder is back on disk',
      existsSync(join(profileDir, 'node_modules', 'dsh-plugin-gamma', 'index.js')))
  } finally {
    await panel.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`\n[verify-rescue-web] crashed: ${error?.stack ?? error}`)
  process.exitCode = 1
})
