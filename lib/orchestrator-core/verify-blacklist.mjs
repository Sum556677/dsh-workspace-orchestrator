#!/usr/bin/env node
// Verify single-mode BLACKLIST enforcement and the isolated-instance overlay injection.
//
//   node lib/orchestrator-core/verify-blacklist.mjs [--home D:\tmp\dsh-test]
//
// Uses a fake loader (no DSH process): `createSingleMode` accepts an `applyRow` injection
// point precisely so this logic can be exercised without a live tree.
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createSingleMode, readMapping, writeMapping, pathKey, isProtectedId } from '../single-mode.mjs'

const argv = process.argv.slice(2)
const argHome = (() => {
  const i = argv.indexOf('--home')
  if (i >= 0) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--home='))
  return eq ? eq.slice('--home='.length) : ''
})()
const HOME = resolve(argHome || process.env.DSH_HOME || join(tmpdir(), 'blacklist-test'))

function assertDisposable(home) {
  const real = resolve(homedir(), '.dsh').toLowerCase()
  const target = resolve(home).toLowerCase()
  if (target === real) throw new Error(`拒绝在真实 DSH_HOME 上运行测试：${home}`)
  if (!/dsh-test|blacklist-test/i.test(target)) {
    throw new Error(`测试目录看起来不是一次性目录，已拒绝：${home}`)
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** An in-memory loader: ids -> {disabled}. */
function makeLoader(ids) {
  const rows = new Map()
  for (const id of ids) rows.set(id, { options: { id, name: id }, disabled: false })
  return {
    entries: () => [...rows.values()],
    state: () => Object.fromEntries([...rows].map(([id, row]) => [id, row.disabled ? 'off' : 'on'])),
    entriesMap: rows,
  }
}

/** A single-mode instance whose row flips are recorded instead of applied to React state. */
function makeSingleMode(loader, mappingPath) {
  const flipped = []
  const logs = []
  const ctx = {
    get: (name) => (name === 'loader' ? loader : name === 'sessions' ? { list: () => [] } : undefined),
    on: () => () => {},
    logger: { warn: () => {} },
  }
  const mode = createSingleMode({
    ctx,
    mappingPath,
    log: (message) => logs.push(message),
    // Mirror the real Entry.update(): async, and the observable state settles later.
    applyRow: async (entry, enabled) => {
      const target = !enabled
      const changed = entry.disabled !== target
      if (!changed) return false
      await new Promise((done) => setTimeout(done, 5))
      entry.disabled = target
      flipped.push(`${entry.options.id}:${enabled ? 'on' : 'off'}`)
      return true
    },
  })
  return { mode, flipped, logs }
}

/**
 * A loader whose update() is async *and* whose state settles slowly, exactly like
 * cordis-plugin-loader: `update()` resolves before the fiber has actually stopped.
 */
function makeAsyncLoader(ids, settleMs = 120) {
  const rows = new Map()
  for (const id of ids) {
    rows.set(id, {
      options: { id, name: id },
      disabled: false,
      // Real shape: update() awaits, then the fiber settles a while later.
      update: async function (patch) {
        const target = patch?.disabled === true
        await new Promise((done) => setTimeout(done, 10))
        setTimeout(() => { this.disabled = target }, settleMs)
      },
    })
  }
  return {
    entries: () => [...rows.values()],
    state: () => Object.fromEntries([...rows].map(([id, row]) => [id, row.disabled ? 'off' : 'on'])),
    entriesMap: rows,
  }
}

const WS_A = 'D:/ws/novels'
const WS_B = 'D:/ws/code'

/** Run a handler/await the reconcile pass it kicked off. */
async function apply(mode, cwd) {
  const result = mode.handleSessionCreated({ header: { cwd } })
  await mode.lastRun
  return result
}

async function main() {
  assertDisposable(HOME)
  if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true })
  const mappingPath = join(HOME, 'workspace-orchestrator', 'single-mode.json')
  mkdirSync(join(HOME, 'workspace-orchestrator'), { recursive: true })
  console.log(`\n[fixture] mapping = ${mappingPath}\n`)

  // ---- storage shape ------------------------------------------------------
  writeMapping(mappingPath, {
    [WS_A]: { disabledPlugins: ['plugin-x', 'plugin-y'] },
    [WS_B]: { disabledPlugins: [] },
  })
  const raw = JSON.parse(readFileSync(mappingPath, 'utf8'))
  check('writes version 2', raw.version === 2)
  check('stores disabledPlugins records',
    JSON.stringify(raw.workspaces[WS_A]) === '{"disabledPlugins":["plugin-x","plugin-y"]}',
    JSON.stringify(raw.workspaces))
  const readBack = readMapping(mappingPath)
  check('reads the blacklist back', JSON.stringify(readBack.workspaces.get(pathKey(WS_A))) === '["plugin-x","plugin-y"]')
  check('accepts a bare array when writing (normalised)',
    (() => { writeMapping(mappingPath, { [WS_B]: ['z'] }); return JSON.stringify(JSON.parse(readFileSync(mappingPath, 'utf8')).workspaces[WS_B]) === '{"disabledPlugins":["z"]}' })())

  // rewrite the canonical fixture
  writeMapping(mappingPath, {
    [WS_A]: { disabledPlugins: ['plugin-x'] },
    [WS_B]: { disabledPlugins: ['plugin-y'] },
  })

  // ---- runtime enforcement ------------------------------------------------
  const loader = makeLoader(['plugin-x', 'plugin-y', 'plugin-z'])
  const { mode } = makeSingleMode(loader, mappingPath)

  // Enter A: x must go OFF, y and z stay ON.
  let result = await apply(mode, 'D:/ws/novels')
  check('entering a workspace applies its blacklist', result.status === 'active', JSON.stringify(result))
  check('blacklisted row is disabled', loader.state()['plugin-x'] === 'off', JSON.stringify(loader.state()))
  check('non-blacklisted rows stay enabled',
    loader.state()['plugin-y'] === 'on' && loader.state()['plugin-z'] === 'on', JSON.stringify(loader.state()))

  // Simulate the native panel turning x back ON while we are in A, then re-entering A.
  // This is the exact scenario the user reported: native "enable all" must not win.
  loader.entriesMap.get('plugin-x').disabled = false
  await apply(mode, 'D:/ws/novels')
  check('re-entering the same workspace re-disables a natively-re-enabled row',
    loader.state()['plugin-x'] === 'off', JSON.stringify(loader.state()))

  // Switch to B: y must go OFF, and x (A's blacklist entry) must be restored ON.
  await apply(mode, 'D:/ws/code')
  check('switching workspace applies the new blacklist',
    loader.state()['plugin-y'] === 'off', JSON.stringify(loader.state()))
  check('leaving a workspace restores rows it had disabled',
    loader.state()['plugin-x'] === 'on', JSON.stringify(loader.state()))
  check('rows nobody blacklisted are untouched', loader.state()['plugin-z'] === 'on')

  // A workspace with an empty blacklist restores everything.
  writeMapping(mappingPath, { [WS_A]: { disabledPlugins: [] }, [WS_B]: { disabledPlugins: [] } })
  await apply(mode, 'D:/ws/code')
  check('an empty blacklist restores every managed row',
    Object.values(loader.state()).every((v) => v === 'on'), JSON.stringify(loader.state()))

  // ---- ASYNC SETTLE: the bug the user hit ---------------------------------
  // A real Entry.update() resolves before the fiber has stopped, so a naive
  // "fire and forget" leaves the plugin running. The reconciler must wait it out.
  {
    const slow = makeAsyncLoader(['plugin-x', 'plugin-y'], 120)
    writeMapping(mappingPath, { [WS_A]: { disabledPlugins: ['plugin-x'] } })
    const slowMode = createSingleMode({
      ctx: {
        get: (name) => (name === 'loader' ? slow : name === 'sessions' ? { list: () => [] } : undefined),
        on: () => () => {},
        logger: { warn: () => {} },
      },
      mappingPath,
      log: () => {},
      // Use the REAL default implementation, which awaits entry.update().
    })
    await apply(slowMode, WS_A)
    check('awaits the async fiber teardown before reporting', slow.state()['plugin-x'] === 'off',
      JSON.stringify(slow.state()))
    check('non-blacklisted row still runs after a slow settle', slow.state()['plugin-y'] === 'on')
  }

  // ---- FAILURE MUST BE LOUD -----------------------------------------------
  // A row whose update throws must produce a warn log naming the id and the state.
  {
    const logs = []
    const badLoader = makeLoader(['plugin-x'])
    badLoader.entriesMap.get('plugin-x').options.id = 'plugin-x'
    const badMode = createSingleMode({
      ctx: {
        get: (name) => (name === 'loader' ? badLoader : name === 'sessions' ? { list: () => [] } : undefined),
        on: () => () => {},
        logger: { warn: () => {} },
      },
      mappingPath,
      log: (message) => logs.push(message),
      applyRow: async () => { throw new Error('fiber refused to dispose') },
    })
    writeMapping(mappingPath, { [WS_A]: { disabledPlugins: ['plugin-x'] } })
    await apply(badMode, WS_A)
    check('a throwing update is reported, not swallowed',
      logs.some((line) => line.includes('plugin-x') && line.includes('fiber refused to dispose')),
      JSON.stringify(logs))
  }

  // A row that accepts the call but never actually changes state must also be reported.
  {
    const logs = []
    const stuckLoader = makeLoader(['plugin-x'])
    const stuckMode = createSingleMode({
      ctx: {
        get: (name) => (name === 'loader' ? stuckLoader : name === 'sessions' ? { list: () => [] } : undefined),
        on: () => () => {},
        logger: { warn: () => {} },
      },
      mappingPath,
      log: (message) => logs.push(message),
      // "Succeeds" but the observable state never changes.
      applyRow: async () => true,
    })
    writeMapping(mappingPath, { [WS_A]: { disabledPlugins: ['plugin-x'] } })
    await apply(stuckMode, WS_A)
    check('a silent no-op is detected via state verification',
      logs.some((line) => line.includes('plugin-x') && line.includes('未生效')), JSON.stringify(logs))
  }

  // ---- PATH KEY ROBUSTNESS ------------------------------------------------
  {
    const forms = [
      'D:\\Agent_workspaces\\DSH_plugin',
      'd:/agent_workspaces/dsh_plugin',
      'D:\\Agent_workspaces\\DSH_plugin\\',
      'D:\\Agent_workspaces\\DSH_plugin   ',
      'D:/Agent_workspaces/DSH_plugin/.',
      'D:\\AGENT_WORKSPACES\\dsh_plugin',
      '\\\\?\\D:\\Agent_workspaces\\DSH_plugin',
    ]
    const keys = new Set(forms.map((f) => pathKey(f)))
    check('every Windows spelling of one path yields one key', keys.size === 1, JSON.stringify([...keys]))
    check('pathKey does not mangle a drive root', pathKey('D:\\') === 'd:/' || pathKey('D:\\') === 'd:', pathKey('D:\\'))
    check('pathKey keeps distinct paths distinct',
      pathKey('D:/a/b') !== pathKey('D:/a/bc'), `${pathKey('D:/a/b')} vs ${pathKey('D:/a/bc')}`)
  }

  // ---- unknown ids are tolerated ------------------------------------------
  writeMapping(mappingPath, { [WS_A]: { disabledPlugins: ['ghost-row', 'plugin-x'] } })
  result = await apply(mode, 'D:/ws/novels')
  check('a blacklisted id with no loader row does not throw', result.status === 'active')
  check('the real row is still disabled', loader.state()['plugin-x'] === 'off')

  // ---- concurrency freeze still wins -------------------------------------
  const ctx2 = {
    get: (name) => (name === 'loader' ? loader : name === 'sessions'
      ? { list: () => [{ header: { cwd: 'D:/a' } }, { header: { cwd: 'D:/b' } }] }
      : undefined),
    on: () => () => {},
    logger: { warn: () => {} },
  }
  const frozenMode = createSingleMode({ ctx: ctx2, mappingPath, log: () => {}, applyRow: () => true })
  const frozen = frozenMode.handleSessionCreated({ header: { cwd: 'D:/ws/novels' } })
  check('concurrency freeze still prevents any switch', frozen.status === 'frozen' && frozen.frozen === true)

  // ---- SELF-PROTECTION: the orchestrator must never disable itself ---------
  // Storing its own id in a blacklist used to take the host half (and this listener)
  // down, which the panel then reported as "single mode is not running".
  {
    const selfLoader = makeLoader(['dsh-workspace-orchestrator', 'plugin-x'])
    const selfMode = createSingleMode({
      ctx: {
        get: (name) => (name === 'loader' ? selfLoader : name === 'sessions' ? { list: () => [] } : undefined),
        on: () => () => {},
        logger: { warn: () => {} },
      },
      mappingPath,
      log: () => {},
      applyRow: async (entry, enabled) => { entry.disabled = !enabled; return true },
    })
    // writeMapping already drops it, so simulate a FILE written by an older build
    // (the real-world case) to prove readMapping defuses it on load.
    writeFileSync(mappingPath, JSON.stringify({
      version: 2,
      workspaces: { [WS_A]: { disabledPlugins: ['dsh-workspace-orchestrator', 'plugin-x'] } },
    }, null, 2))
    const selfRead = readMapping(mappingPath)
    check('readMapping strips the orchestrator id from a blacklist',
      !selfRead.workspaces.get(pathKey(WS_A)).includes('dsh-workspace-orchestrator'),
      JSON.stringify([...selfRead.workspaces.get(pathKey(WS_A))]))
    check('the stripped id is reported in ignored[]',
      selfRead.ignored.some((row) => row.id === 'dsh-workspace-orchestrator'), JSON.stringify(selfRead.ignored))
    await apply(selfMode, WS_A)
    check('the orchestrator row is never disabled at runtime',
      selfLoader.state()['dsh-workspace-orchestrator'] === 'on', JSON.stringify(selfLoader.state()))
    check('other rows in the same blacklist are still applied',
      selfLoader.state()['plugin-x'] === 'off', JSON.stringify(selfLoader.state()))

    // writeMapping refuses to persist it even when asked directly.
    const written = writeMapping(mappingPath, { [WS_A]: { disabledPlugins: ['dsh-workspace-orchestrator', 'y'] } })
    check('writeMapping refuses to persist the orchestrator id',
      JSON.stringify(written.workspaces[WS_A].disabledPlugins) === '["y"]', JSON.stringify(written.workspaces[WS_A]))
    check('writeMapping reports the rejected id',
      written.rejected.some((row) => row.id === 'dsh-workspace-orchestrator'), JSON.stringify(written.rejected))
    check('isProtectedId recognises every form of our own id',
      ['dsh-workspace-orchestrator', 'plugin-orchestrator', 'some/workspace-orchestrator'].every((id) => isProtectedId(id)),
      '')
    check('isProtectedId leaves ordinary plugins alone',
      !isProtectedId('dsh-webds-bridge') && !isProtectedId('plugin-x'))
  }

  // ---- DEBUG CHANNEL: a file the user can always find ----------------------
  {
    const { createDebugSingleModeTool } = await import('../tools/debug-single-mode.js')
    const logHome = join(HOME, 'debug-case')
    rmSync(logHome, { recursive: true, force: true })
    const logMapping = join(logHome, 'workspace-orchestrator', 'single-mode.json')
    writeMapping(logMapping, { [WS_A]: { disabledPlugins: ['plugin-x'] } })
    const rows = new Map([
      ['plugin-x', { options: { id: 'plugin-x', disabled: true }, fiber: undefined, get disabled() { return this.options.disabled === true } }],
      ['plugin-y', { options: { id: 'plugin-y' }, fiber: { uid: 9, state: 2 }, get disabled() { return this.options.disabled === true } }],
    ])
    const debugCtx = {
      get: (name) => (name === 'loader' ? { entries: () => [...rows.values()] }
        : name === 'sessions' ? { list: () => [{ header: { cwd: WS_A } }] } : undefined),
      on: () => () => {},
      logger: { warn: () => {} },
    }
    const mode2 = createSingleMode({ ctx: debugCtx, mappingPath: logMapping, debug: true })
    await mode2.reconcileNow(WS_A)
    const debugLog = join(logHome, 'workspace-orchestrator', 'debug.log')
    check('debug.log is written beside the mapping when debug is on', existsSync(debugLog), debugLog)

    // Opt-in contract: with debug off, nothing is written to disk.
    {
      const quietHome = join(HOME, 'quiet-case')
      rmSync(quietHome, { recursive: true, force: true })
      const quietMapping = join(quietHome, 'workspace-orchestrator', 'single-mode.json')
      writeMapping(quietMapping, { [WS_A]: { disabledPlugins: ['plugin-x'] } })
      const quiet = createSingleMode({ ctx: debugCtx, mappingPath: quietMapping, debug: false })
      await quiet.reconcileNow(WS_A)
      check('no debug.log is written when debug is off',
        !existsSync(join(quietHome, 'workspace-orchestrator', 'debug.log')),
        'debug.log should not exist')
      check('debug defaults to off', (() => {
        const prior = process.env.DSH_ORCH_DEBUG
        delete process.env.DSH_ORCH_DEBUG
        const d = createSingleMode({ ctx: debugCtx, mappingPath: quietMapping })
        const off = d.debug === false
        if (prior !== undefined) process.env.DSH_ORCH_DEBUG = prior
        return off
      })())
    }

    const text = existsSync(debugLog) ? readFileSync(debugLog, 'utf8') : ''
    check('debug.log carries the [single-mode DEBUG] prefix', text.includes('[single-mode DEBUG]'))
    check('debug.log records the session cwd and pathKey', text.includes('raw cwd') && text.includes('pathKey(cwd)'))
    check('debug.log records per-row fiber state', text.includes('fiber.uid') && text.includes('[row plugin-x]'))
    check('debug.log has no duplicated lines', (() => {
      const lines = text.split('\n').filter(Boolean).map((line) => line.replace(/^\S+\s/, ''))
      return new Set(lines).size === lines.length
    })(), 'duplicate line detected')

    // The tool must answer ACTIVE vs DISPOSED on its own.
    const tool = createDebugSingleModeTool(debugCtx)
    const value = await tool.execute({ mappingPath: logMapping })
    check('debug_single_mode runs without throwing', Boolean(value))
    check('debug_single_mode reports the blacklist', JSON.stringify(value.blacklist) === '["plugin-x"]')
    const px = (value.rows ?? []).find((row) => row.id === 'plugin-x')
    const py = (value.rows ?? []).find((row) => row.id === 'plugin-y')
    check('debug_single_mode shows a disabled row as not active', px && px.disabled === true && px.fiberActive === false,
      JSON.stringify(px))
    check('debug_single_mode shows a running row as ACTIVE', py && py.fiberActive === true && py.fiberState === 'ACTIVE',
      JSON.stringify(py))
    check('debug_single_mode reaches a verdict', (value.findings ?? []).some((finding) => finding.includes('工作正常')),
      JSON.stringify(value.findings))
    const rendered = tool.output.render({}, value)[0].text
    check('debug_single_mode renders a readable report',
      rendered.includes('debug_single_mode') && rendered.includes('plugin-x'))
  }

  // ---- reconcileNow (called by the panel when a box is ticked) ------------
  {
    const quick = makeLoader(['plugin-x', 'plugin-y'])
    writeMapping(mappingPath, { [WS_A]: { disabledPlugins: ['plugin-y'] } })
    const quickMode = createSingleMode({
      ctx: {
        get: (name) => (name === 'loader' ? quick : name === 'sessions' ? { list: () => [] } : undefined),
        on: () => () => {},
        logger: { warn: () => {} },
      },
      mappingPath,
      log: () => {},
      applyRow: async (entry, enabled) => { entry.disabled = !enabled; return true },
    })
    await quickMode.reconcileNow(WS_A)
    check('reconcileNow applies a blacklist without a new session', quick.state()['plugin-y'] === 'off',
      JSON.stringify(quick.state()))
  }

  // ---- legacy allowlist ---------------------------------------------------
  writeFileSync(mappingPath, JSON.stringify({ version: 1, workspaces: { [WS_A]: ['plugin-x'] } }))
  const legacy = readMapping(mappingPath)
  check('legacy allowlist is reported in migrated[]', JSON.stringify(legacy.migrated) === JSON.stringify([WS_A]))
  check('legacy allowlist reads as an empty blacklist (all enabled)',
    JSON.stringify(legacy.workspaces.get(pathKey(WS_A))) === '[]')

  // ---- isolated instance overlay -----------------------------------------
  // Exercise the REAL `#renderOverlay` by extracting it verbatim from the source and
  // running it, then parsing the result with the production patch-row parser.
  {
    const src = readFileSync(join(import.meta.dirname, 'src', 'orchestrator.mjs'), 'utf8')
    /** Text from `startMarker` up to and including `endMarker`. */
    const slice = (startMarker, endMarker) => {
      const a = src.indexOf(startMarker)
      if (a < 0) throw new Error(`marker not found: ${startMarker}`)
      const b = src.indexOf(endMarker, a + startMarker.length)
      if (b < 0) throw new Error(`end marker not found for ${startMarker}`)
      return src.slice(a, b + endMarker.length)
    }
    const storage = slice('const STORAGE_ROWS = [', '\n]')
    const yamlPathFn = slice('function yamlPath(p) {', '\n}')
    const yamlScalarFn = slice('function yamlScalar(value) {', '\n}')
    const renderFn = slice('  #renderOverlay(dataRoot, blacklist = []) {', '\n  }')
      .replace('#renderOverlay', 'function renderOverlay')
      .replace(/^ {2}/gm, '')
    const moduleText = [
      "import { join } from 'node:path'",
      storage, yamlPathFn, yamlScalarFn, renderFn,
      'export { renderOverlay }', '',
    ].join('\n')
    // Keep the scratch module out of the fixture home: a stray .mjs there confuses
    // profile resolution and is not part of what we are testing.
    const tempFile = join(tmpdir(), `render-overlay-${process.pid}.mjs`)
    writeFileSync(tempFile, moduleText, 'utf8')
    let renderOverlay
    try {
      ({ renderOverlay } = await import(`file:///${tempFile.replace(/\\/g, '/')}`))
    } finally {
      rmSync(tempFile, { force: true })
    }
    const overlay = renderOverlay('D:/tmp/inst', ['dsh-novel-writer', 'dsh-code-helper'])
    const { parsePatchRows } = await import('./src/profile-patch.mjs')
    const disabled = parsePatchRows(overlay).filter((r) => r.disabled === 'true').map((r) => r.id)
    check('isolated-instance overlay disables exactly the blacklisted rows',
      JSON.stringify(disabled) === '["dsh-novel-writer","dsh-code-helper"]', JSON.stringify(disabled))
    check('overlay still holds the storage isolation rows',
      parsePatchRows(overlay).some((r) => r.id === 'storage-json')
      && parsePatchRows(overlay).some((r) => r.id === 'session-persistence-jsonl'))
    // A hostile id must not be able to inject extra rows through the overlay.
    const evil = renderOverlay('D:/tmp/inst', ['ok-id\n- id: injected\n  disabled: false'])
    const evilRows = parsePatchRows(evil).filter((r) => r.id === 'injected')
    check('a crafted id cannot inject extra rows into the overlay', !evilRows.some((r) => r.disabled === 'false'),
      JSON.stringify(parsePatchRows(evil).map((r) => r.id)))
  }

  const orchestratorSrc = readFileSync(join(import.meta.dirname, 'src', 'orchestrator.mjs'), 'utf8')
  check('prepare() accepts a blacklist option', /options\.blacklist/.test(orchestratorSrc))
  check('shareData mode ignores the blacklist (rescue must stay raw)',
    /options\.shareData === true \? \[\] : \[\.\.\.\(options\.blacklist/.test(orchestratorSrc))
}

try {
  await main()
} catch (error) {
  console.error(`\n[verify-blacklist] crashed: ${error?.stack ?? error}`)
  process.exitCode = 1
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exitCode = 1
}


