/**
 * 急救 Web 服务（与 DSH 进程完全解耦）。
 *
 * 只用 node 内置模块：一个 HTTP 服务 + 一段内联 HTML。
 * 页面三个区块：冲突告警 / 插件列表 / 已隔离备份。
 *
 * 插件有两种加载方式，急救必须两种都覆盖：
 *   1. node_modules 插件 → 「禁用并隔离」是可逆移动，不删代码：
 *        profiles/<p>/node_modules/<pkg> → $DSH_HOME/workspace-orchestrator/disabled/<pkg>@<ver>/payload
 *      同时追加 `- id: <row>\n  disabled: true`（先备份），追加原文记进 quarantine.json。
 *   2. bundle 插件（profile 的 package.json → dsh.profile.bundles）没有可移动的文件夹，
 *      只能改配置：入口 id 取自该 bundle 自己的 cordis.patch.yml（真实 id，不是包名），
 *      在 profile patch 末尾追加 disabled 行（补丁后置覆盖前置，已由 dsh-app-boot 源码确认）。
 *      「彻底移除」另把包名从 dsh.profile.bundles 与 dependencies 中摘掉，改前一并备份。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'

import { analyzeConflicts, collectFacts, parseRows } from './conflict-scan.mjs'
import { parsePatchYaml, projectPatchEntries } from './patch-yaml.js'
import { resolveDshHome } from './orchestrator-core/src/paths.mjs'

const DEFAULT_PORT = 8765
const OFFICIAL_PREFIX = '@deepseek-ai/'

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** stat that answers null instead of throwing (a locked/vanished entry must not kill a scan). */
const statOrNull = (file) => {
  try { return statSync(file) } catch { return null }
}

const isDir = (file) => Boolean(statOrNull(file)?.isDirectory())

/** Directory entries, or [] when unreadable. */
const listDir = (dir) => {
  try { return readdirSync(dir) } catch { return [] }
}

const pkgPath = (name) => String(name ?? '').split('/')

/** Only here to spot `..` / separators / drive letters in user-supplied names. */
const SEGMENT_OK = /^[A-Za-z0-9._@~+-]+$/

/** A package name safe to append under a node_modules root. */
function isSafeSegment(name) {
  return SEGMENT_OK.test(name) && name !== '.' && name !== '..'
}

/** `@scope/name` or `name`, each segment safe. */
function isSafePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  const parts = name.split('/')
  if (parts.length > 2) return false
  if (parts.length === 2 && !parts[0].startsWith('@')) return false
  return parts.every(isSafeSegment)
}

/** True when `child` resolves to a path strictly inside `parent`. */
function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** quarantine dir slug for a package: `@scope/name@1.0.0` → `@scope__name@1.0.0`. */
function slugFor(packageName) {
  return `${String(packageName).replace(/[/\\]/g, '__')}@`
}

/** A slug from the HTTP surface: one entry name, no separators, no traversal. */
function isSafeSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && slug.length < 200
    && !slug.includes('/') && !slug.includes('\\') && slug !== '.' && slug !== '..'
}

/** The profile's patch rows (offline parse; a malformed file yields no rows, never a throw). */
function readRows(profileDir) {
  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchFile)) return { patchFile, rows: [] }
  try {
    const parsed = parsePatchYaml(readFileSync(patchFile, 'utf8'))
    const { inserts } = projectPatchEntries(parsed.entries)
    return { patchFile, rows: inserts ?? [] }
  } catch {
    return { patchFile, rows: [] }
  }
}

/** node_modules entries: any directory holding a readable package.json (official ones included). */
function listInstalled(profileDir) {
  const root = join(profileDir, 'node_modules')
  if (!isDir(root)) return []
  const found = []
  for (const entry of listDir(root)) {
    if (entry.startsWith('.')) continue
    const candidates = []
    if (entry.startsWith('@')) {
      const scopeDir = join(root, entry)
      if (!isDir(scopeDir)) continue
      for (const inner of listDir(scopeDir)) candidates.push([join(scopeDir, inner), inner])
    } else {
      candidates.push([join(root, entry), entry])
    }
    for (const [dir, fallback] of candidates) {
      if (!isDir(dir)) continue
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest) found.push({ name: manifest.name ?? entry + '/' + fallback, version: manifest.version ?? null, dir })
    }
  }
  return found
}

/* ------------------------------------------------- bundle (dsh.profile.bundles) */

/** The profile manifest, or null. */
const readProfileManifest = (profileDir) => readJson(join(profileDir, 'package.json'))

/**
 * Package names selected as bundles (`dsh.profile.bundles`), official ones dropped.
 * These are loaded through the manifest, so they may have no `node_modules` folder of
 * their own identity to move — a crash caused by one cannot be fixed by moving files.
 */
function listBundles(profileDir) {
  const manifest = readProfileManifest(profileDir)
  const raw = manifest?.dsh?.profile?.bundles
  const names = Array.isArray(raw) ? raw.filter((b) => typeof b === 'string' && b.trim() !== '') : []
  return {
    manifest,
    bundles: names.filter((name) => !name.startsWith(OFFICIAL_PREFIX)),
  }
}

/**
 * The loader-entry ids a bundle actually inserts, read from the bundle's own patch file
 * (`package.json` → `dsh.bundle.patch`). Ids are NOT the package name in general: one
 * bundle may insert several rows, so the real ids are what the disable row must target.
 *
 * Falls back to the package name when the bundle declares no readable patch, and flags
 * `guess: true` so the UI can say the id came from a fallback rather than the manifest.
 * @returns {{dir: string|null, version: string|null, patchFile: string|null,
 *            entryIds: string[], names: string[], guess: boolean, note: string|null}}
 */
function bundleEntries(profileDir, packageName) {
  const dir = join(profileDir, 'node_modules', ...pkgPath(packageName))
  const manifest = isDir(dir) ? readJson(join(dir, 'package.json')) : null
  const result = {
    dir: manifest ? dir : null,
    version: manifest?.version ?? null,
    patchFile: null,
    entryIds: [],
    names: [],
    guess: false,
    note: null,
  }
  const declared = manifest?.dsh?.bundle?.patch
  if (typeof declared !== 'string' || declared.trim() === '') {
    // No declaration: the folder may be missing entirely (the package is only named in
    // dsh.profile.bundles) or present without a patch. Either way the real ids are
    // unknown, so fall back to the package name and say so.
    result.guess = true
    result.entryIds = [packageName]
    result.note = manifest
      ? 'bundle 未声明 dsh.bundle.patch，无法读取真实入口 id，暂用包名'
      : 'bundle 没有安装目录，无法读取真实入口 id，暂用包名'
    return result
  }
  // The declared path may point outside the package in a hand-edited manifest; keep it
  // inside the bundle directory so a crafted manifest cannot make us read elsewhere.
  const patchFile = resolve(dir, declared)
  if (!isInside(dir, patchFile) && patchFile !== resolve(dir)) {
    result.note = `dsh.bundle.patch 指向包外路径，已忽略：${declared}`
    return result
  }
  result.patchFile = patchFile
  if (!existsSync(patchFile)) {
    result.note = `dsh.bundle.patch 指向的文件不存在：${declared}`
    return result
  }
  const rows = rowsIn(readFileSync(patchFile, 'utf8'))
  // Rows the bundle inserts for itself: a row's `name` may be the package or a subpath.
  const own = rows.filter((row) => {
    const name = String(row.name ?? '')
    if (!name) return false
    return name === packageName || name.startsWith(`${packageName}/`)
      || name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/') === packageName
  })
  const ids = []
  const names = []
  for (const row of own) {
    if (!row.id) continue
    if (!ids.includes(row.id)) ids.push(row.id)
    if (!names.includes(row.name)) names.push(row.name)
  }
  result.entryIds = ids
  result.names = names
  if (ids.length === 0) {
    result.guess = true
    result.entryIds = [packageName]
    result.note = 'bundle 的 patch 里没有可识别的入口 id，暂用包名作为 id（可能不生效）'
  }
  return result
}

/**
 * Append disable rows for every entry id into the profile patch, with a backup.
 * Patches apply in order, so a later top-level `- id:` row shadows the bundle's own
 * `- insert:` row with the same id. Returns the exact text appended.
 */
function appendDisableRows(patchFile, ids) {
  if (ids.length === 0) return { appended: '', backup: null }
  const text = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  const appended = sep + ids.map(disableRow).join('')
  let backup = null
  if (existsSync(patchFile)) backup = copyBackup(patchFile)
  writeFileSync(patchFile, text + appended, 'utf8')
  return { appended, backup }
}

/**
 * Every `- id: <id>` row currently in the profile patch that carries `disabled: true`.
 * A bundle entry already disabled by the user has its own row; the bundle action must
 * target that id too, or "disable" is a no-op in the UI.
 */
function disabledRowIds(patchFile) {
  if (!existsSync(patchFile)) return []
  try {
    return rowsIn(readFileSync(patchFile, 'utf8'))
      .filter((row) => row.disabled === true)
      .map((row) => row.id)
      .filter(Boolean)
  } catch {
    return []
  }
}

function listDisabled(home) {
  const root = join(home, 'workspace-orchestrator', 'disabled')
  if (!isDir(root)) return []
  const items = []
  for (const entry of listDir(root)) {
    const dir = join(root, entry)
    if (!isDir(dir)) continue
    const record = readJson(join(dir, 'quarantine.json'))
    if (!record) continue
    items.push({
      dir,
      slug: entry,
      packageName: record.packageName ?? null,
      version: record.version ?? null,
      profile: record.profile ?? null,
      originalPath: record.originalPath ?? null,
      at: record.at ?? null,
      rows: Array.isArray(record.rows) ? record.rows : [],
      payloadPresent: isDir(join(dir, 'payload')),
      kind: record.kind === 'bundle' ? 'bundle' : 'package',
    })
  }
  return items.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
}

async function buildState(ctx) {
  const profileDir = join(ctx.home, 'profiles', ctx.profileName)
  const { patchFile, rows } = readRows(profileDir)

  // The scanner is best-effort: a profile with an unreadable/odd patch must still render.
  let report = { errors: [], warnings: [], notes: [] }
  const degraded = []
  try {
    const facts = collectFacts(profileDir, rows)
    report = analyzeConflicts({ rows, facts: facts.facts, unread: facts.unread, profileDir })
  } catch (error) {
    degraded.push({ code: 'scan-failed', level: 'warning', message: `冲突扫描失败，已跳过：${error?.message ?? error}` })
  }

  const installed = listInstalled(profileDir)
  const disabled = listDisabled(ctx.home)
  const quarantined = new Set(disabled.map((item) => item.packageName).filter(Boolean))
  const byName = new Map()
  for (const row of rows) if (typeof row.name === 'string') byName.set(row.name, row)
  const plugins = []
  const listed = new Set()

  // (a) bundles selected in dsh.profile.bundles. They load from the manifest, so a
  // crash caused by one has no folder to move — it must be listed even when it has
  // no node_modules entry at all, otherwise the rescue tool cannot see it.
  const bundleState = listBundles(profileDir)
  // Disable rows may be name-less (`- id: <entryId>`), so the disabling id is collected
  // from the whole document, not only from named insert rows. "Last row wins" is the
  // patch semantics, so later rows override earlier ones.
  const disabledIds = new Set(
    rowsIn(existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '')
      .filter((row) => row.disabled === true)
      .map((row) => row.id)
      .filter(Boolean),
  )
  for (const name of bundleState.bundles) {
    const entries = bundleEntries(profileDir, name)
    listed.add(name)
    // A bundle is enabled unless every one of its entry ids is disabled by patch.
    const allDisabled = entries.entryIds.length > 0 && entries.entryIds.every((id) => disabledIds.has(id))
    plugins.push({
      name,
      kind: 'bundle',
      version: entries.version,
      rowId: entries.entryIds[0] ?? null,
      entryIds: entries.entryIds,
      idGuess: entries.guess,
      enabled: !allDisabled,
      registered: true,
      location: entries.dir,
      bundle: true,
      movable: false, // nothing to move; disable = patch row (+ optional manifest removal)
      hasFolder: Boolean(entries.dir),
      disabledByPatch: allDisabled,
      note: entries.note,
    })
  }

  // (b) third-party packages present in node_modules.
  for (const pkg of installed) {
    if (pkg.name.startsWith(OFFICIAL_PREFIX)) continue
    if (listed.has(pkg.name)) continue
    const row = byName.get(pkg.name)
    listed.add(pkg.name)
    plugins.push({
      name: pkg.name,
      kind: 'package',
      version: pkg.version,
      rowId: row?.id ?? null,
      // Installed but never registered in the patch: it is not running, and saying
      // "disabled" would hide the fact that patch edit alone cannot start it.
      enabled: row ? row.disabled !== true : false,
      registered: Boolean(row),
      disabledByPatch: row?.disabled === true,
      location: pkg.dir,
      movable: true,
    })
  }

  // (c) patch 里有、但 node_modules 里已不存在的行：可能是被隔离了，也可能是装坏了
  for (const row of rows) {
    if (String(row.name ?? '').startsWith(OFFICIAL_PREFIX)) continue
    if (listed.has(row.name)) continue
    listed.add(row.name)
    const isQuarantined = quarantined.has(row.name)
    plugins.push({
      name: row.name,
      kind: 'package',
      version: null,
      rowId: row.id ?? null,
      enabled: false,
      registered: true,
      disabledByPatch: row.disabled === true,
      location: null,
      quarantined: isQuarantined,
      missing: !isQuarantined,
      movable: true,
    })
  }

  return {
    profile: ctx.profileName,
    profileDir,
    patchFile,
    patchExists: existsSync(patchFile),
    errorCount: report.errors?.length ?? 0,
    warningCount: report.warnings?.length ?? 0,
    conflicts: (report.errors ?? []).map((item) => ({ level: 'error', ...item })),
    warnings: [...degraded, ...(report.warnings ?? []).map((item) => ({ level: 'warning', ...item }))],
    notes: report.notes ?? [],
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    bundles: bundleState.bundles,
    manifestFile: join(profileDir, 'package.json'),
    manifestExists: existsSync(join(profileDir, 'package.json')),
    disabled,
  }
}

/**
 * Bundle rescue: no files to move, so disabling means config edits.
 *
 *  - `disable`  : append `- id: <entryId>` + `disabled: true` for every real entry id.
 *                 Patches apply in order, so the later row shadows the bundle's own.
 *  - `uninstall`: the same patch rows, plus removal of the package from
 *                 `dsh.profile.bundles` and `dependencies` in the profile manifest
 *                 (backed up first) so a later install cannot pull it back in.
 *
 * A record is written to the quarantine area so the action shows up as restorable.
 */
function disableBundle(ctx, packageName, { uninstall = false } = {}) {
  if (!isSafePackageName(packageName)) {
    throw Object.assign(new Error(`非法的包名：${JSON.stringify(packageName)}`), { status: 400 })
  }
  const profileDir = join(ctx.home, 'profiles', ctx.profileName)
  const state = listBundles(profileDir)
  if (!state.bundles.includes(packageName)) {
    throw Object.assign(new Error(`bundle 列表里没有 ${packageName}（可能已被移除）`), { status: 404 })
  }
  const entries = bundleEntries(profileDir, packageName)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const manifestFile = join(profileDir, 'package.json')
  const at = new Date().toISOString()
  const slug = `${slugFor(packageName)}${entries.version ?? 'bundle'}`
  const targetDir = join(ctx.home, 'workspace-orchestrator', 'disabled', slug)
  const existingRecord = readJson(join(targetDir, 'quarantine.json'))

  // ---- validate everything BEFORE touching any file (no partial mutations) ----
  let nextManifest = null
  if (uninstall && existsSync(manifestFile)) {
    const manifest = readJson(manifestFile)
    if (!manifest) {
      throw Object.assign(new Error('profile 的 package.json 无法解析，已中止（未改动任何文件）'), { status: 409 })
    }
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const dependencies = (manifest.dependencies && typeof manifest.dependencies === 'object') ? { ...manifest.dependencies } : null
    const hadDependency = dependencies ? Object.hasOwn(dependencies, packageName) : false
    if (!bundles.includes(packageName) && !hadDependency) {
      throw Object.assign(new Error('package.json 里没有该条目，已中止（未改动任何文件）'), { status: 404 })
    }
    if (dependencies) delete dependencies[packageName]
    if (manifest.dsh?.profile) manifest.dsh.profile.bundles = bundles.filter((name) => name !== packageName)
    if (dependencies) manifest.dependencies = dependencies
    nextManifest = manifest
  } else if (uninstall) {
    // "Uninstall" with no manifest to edit would remove nothing; say so up front.
    throw Object.assign(new Error(`找不到 ${manifestFile}，无法执行彻底移除`), { status: 404 })
  }

  // ---- patch rows ------------------------------------------------------------
  // Ids that still need a disable row. An entry id already disabled by hand needs no
  // second row; an action with nothing left to do is reported, not silently "ok".
  const alreadyDisabled = new Set(disabledRowIds(patchFile))
  const targetIds = entries.entryIds.filter((id) => !alreadyDisabled.has(id))
  const { appended, backup } = appendDisableRows(patchFile, targetIds)

  // ---- manifest --------------------------------------------------------------
  let manifestBackup = null
  if (nextManifest) {
    manifestBackup = copyBackup(manifestFile)
    writeFileSync(manifestFile, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
  }

  // ---- quarantine record (merge with an existing one from an earlier action) --
  if (existingRecord) {
    if (appended) existingRecord.appended = `${existingRecord.appended ?? ''}${appended}`
    existingRecord.entryIds = [...new Set([...(existingRecord.entryIds ?? []), ...entries.entryIds])]
    existingRecord.rows = [...new Set([...(existingRecord.rows ?? []), ...entries.entryIds])]
    if (uninstall) {
      existingRecord.uninstalled = true
      existingRecord.manifestBackup = manifestBackup ?? existingRecord.manifestBackup ?? null
    }
    existingRecord.at = at
    writeFileSync(join(targetDir, 'quarantine.json'), JSON.stringify(existingRecord, null, 2), 'utf8')
  } else {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'quarantine.json'), JSON.stringify({
      kind: 'bundle',
      packageName,
      version: entries.version,
      profile: ctx.profileName,
      entryIds: entries.entryIds,
      uninstalled: Boolean(nextManifest),
      rows: [...new Set([...entries.entryIds, ...targetIds])],
      appended,
      manifestBackup,
      patchBackup: backup,
      at,
    }, null, 2), 'utf8')
  }

  return {
    packageName,
    kind: 'bundle',
    entryIds: entries.entryIds,
    idGuess: entries.guess,
    note: entries.note,
    patchPatched: appended !== '',
    patchBackup: backup,
    uninstalled: Boolean(nextManifest),
    manifestBackup,
    slug,
  }
}

/** Undo a bundle disable: remove the patch rows and, if needed, put the manifest back. */
function restoreBundle(ctx, slug) {
  if (!isSafeSlug(slug)) {
    throw Object.assign(new Error(`非法的隔离记录名：${JSON.stringify(slug)}`), { status: 400 })
  }
  const target = join(ctx.home, 'workspace-orchestrator', 'disabled', slug)
  if (!isDir(target)) throw Object.assign(new Error(`隔离记录不存在：${slug}`), { status: 404 })
  const record = readJson(join(target, 'quarantine.json'))
  if (!record || record.kind !== 'bundle') {
    throw Object.assign(new Error(`不是 bundle 隔离记录：${slug}`), { status: 409 })
  }

  const profileDir = join(ctx.home, 'profiles', record.profile ?? ctx.profileName)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  let revertedPatch = false
  let patchNote = null
  if (record.appended && existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const reverted = revertAppend(text, record)
    if (reverted.applied && reverted.text !== text) {
      copyBackup(patchFile)
      writeFileSync(patchFile, reverted.text, 'utf8')
      revertedPatch = true
    } else {
      patchNote = `patch 里的禁用行已被改动（${reverted.reason ?? 'not-found'}），未自动修改。`
    }
  }

  // Re-add the bundle selection / dependency from the backup we took, if it was removed.
  let restoredManifest = false
  let manifestNote = null
  if (record.uninstalled) {
    const manifestFile = join(profileDir, 'package.json')
    const backupFile = String(record.manifestBackup ?? '')
    if (backupFile && isInside(profileDir, backupFile) && existsSync(backupFile)) {
      const backup = readJson(backupFile)
      const current = existsSync(manifestFile) ? readJson(manifestFile) : null
      if (backup && current) {
        const wantedBundles = Array.isArray(backup?.dsh?.profile?.bundles) ? backup.dsh.profile.bundles : []
        const wantedDeps = (backup.dependencies && typeof backup.dependencies === 'object') ? backup.dependencies : null
        const bundles = Array.isArray(current?.dsh?.profile?.bundles) ? [...current.dsh.profile.bundles] : []
        if (!bundles.includes(record.packageName) && wantedBundles.includes(record.packageName)) {
          // Restore the original position when the other entries are still intact.
          const rebuilt = []
          for (const name of wantedBundles) {
            if (name === record.packageName) rebuilt.push(name)
            else if (bundles.includes(name)) rebuilt.push(name)
          }
          for (const name of bundles) if (!rebuilt.includes(name)) rebuilt.push(name)
          if (current.dsh?.profile) current.dsh.profile.bundles = rebuilt
        }
        if (wantedDeps && Object.hasOwn(wantedDeps, record.packageName)) {
          current.dependencies = { ...(current.dependencies ?? {}), [record.packageName]: wantedDeps[record.packageName] }
        }
        copyBackup(manifestFile)
        writeFileSync(manifestFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
        restoredManifest = true
      } else {
        manifestNote = 'package.json 备份无法解析，未还原 manifest；请手工把包名加回 dsh.profile.bundles。'
      }
    } else {
      manifestNote = '找不到 package.json 备份，未还原 manifest；请手工把包名加回 dsh.profile.bundles。'
    }
  }

  rmSync(target, { recursive: true, force: true })
  return {
    packageName: record.packageName,
    kind: 'bundle',
    revertedPatch,
    restoredManifest,
    patchNote: patchNote ?? manifestNote,
  }
}

/** Copy beside itself with a unique name (several edits inside one ms must not clobber a backup). */
function copyBackup(file) {
  const stamp = Date.now()
  let target = `${file}.bak-${stamp}`
  let suffix = 1
  while (existsSync(target)) {
    target = `${file}.bak-${stamp}-${suffix}`
    suffix += 1
  }
  copyFileSync(file, target)
  return target
}

/** Text of a block-level disable row, indented at column 0. */
const disableRow = (id) => `- id: ${id}\n  disabled: true\n`

/**
 * Every `- id:` row in a patch document with its `name` and `disabled` flag, remembering
 * whether it was top-level (a targeted override / our appended row) or came from an
 * `insert:`.
 *
 * Indentation alone cannot tell a loader row from nested plugin configuration: `- insert:`
 * may itself contain another `- insert:` (one bundle inserting per-preset entries), which
 * puts real rows at 8 spaces. So every `- id:` is collected, and callers decide by what
 * they know — a row is ours when its `name` is the package we were asked about.
 */
function rowsIn(text) {
  const rows = []
  let current = null
  const unquote = (value) => String(value).replace(/^['"]|['"]$/g, '')
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const idMatch = /^(\s*)- id:\s*(.+?)\s*$/.exec(raw)
    if (idMatch) {
      current = { id: unquote(idMatch[2]), name: null, disabled: false, top: idMatch[1].length === 0 }
      rows.push(current)
      continue
    }
    if (!current) continue
    // A line dedented back to (or past) the row's own column ends the row.
    if (/^\s*- /.test(raw) || /^\S/.test(raw)) { current = null; continue }
    const nameMatch = /^\s+name:\s*(.+?)\s*$/.exec(raw)
    if (nameMatch) { current.name = unquote(nameMatch[1]); continue }
    const disabledMatch = /^\s+disabled:\s*(\S+)\s*$/.exec(raw)
    if (disabledMatch) current.disabled = disabledMatch[1] === 'true'
  }
  return rows
}

/**
 * Remove the rows we appended, tolerating later edits elsewhere in the file.
 * Textually checked first (the common case: untouched since quarantine), then
 * by re-parsing so a trailing newline or comment added in between cannot strand
 * a `disabled: true` on a plugin the user just restored.
 * @returns {{applied: boolean, reason?: string, text: string}}
 */
function revertAppend(text, appendRecord) {
  const appended = String(appendRecord.appended ?? '')
  if (!appended.trim()) return { applied: false, reason: 'empty', text }
  if (text.endsWith(appended)) return { applied: true, text: text.slice(0, text.length - appended.length) }
  // Later edits moved our rows off the tail: delete the exact appended chunk wherever it
  // sits. The chunk is one contiguous run, so this stays an exact match (no heuristics).
  if (text.includes(appended)) {
    return { applied: true, text: text.replace(appended, '') }
  }

  // Something inside the chunk itself was edited. Disable rows are plain text we can
  // recognise, so try to remove just the disable flags we can prove are ours.
  const ids = new Set(Array.isArray(appendRecord.ids) ? appendRecord.ids : [])
  if (ids.size === 0) return { applied: false, reason: 'no-rows-recorded', text }

  const unquote = (value) => String(value).replace(/^['"]|['"]$/g, '')
  const lines = text.split('\n')
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^- id:\s*(.+?)\s*$/.exec(lines[i])
    if (!header || !ids.has(unquote(header[1]))) { out.push(lines[i]); continue }
    let end = i + 1
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1
    const block = lines.slice(i + 1, end)
    const foreign = block.filter((line) => !/^\s+disabled:\s*true\s*$/.test(line))
    const anchorLine = /^\s+name:\s*(.+?)\s*$/.exec(block.find((line) => /^\s+name:/.test(line)) ?? '')
    const anchorIsOurs = Boolean(anchorLine) && unquote(anchorLine[1]) === appendRecord.packageName
    if (foreign.length > 0) {
      // The row carries more than our lines: keep it, only drop the disable flag.
      out.push(lines[i], ...(anchorIsOurs ? [] : foreign))
    } else if (!anchorIsOurs) {
      // No name line: this is a bare top-level row we appended; drop it entirely.
      out.push(lines[i])
    }
    removed += 1
    i = end - 1
  }
  if (removed === 0) return { applied: false, reason: 'rows-already-gone-or-modified', text }
  return { applied: true, text: out.join('\n') }
}

/** 把包装进隔离区，并在 patch 末尾追加禁用行（备份原文件）。 */
function quarantine(ctx, packageName) {
  if (!isSafePackageName(packageName)) {
    throw Object.assign(new Error(`非法的包名：${JSON.stringify(packageName)}`), { status: 400 })
  }
  const profileDir = join(ctx.home, 'profiles', ctx.profileName)
  const source = join(profileDir, 'node_modules', ...pkgPath(packageName))
  if (!isInside(join(profileDir, 'node_modules'), source)) {
    throw Object.assign(new Error('包路径越界，已拒绝'), { status: 400 })
  }
  if (!isDir(source)) {
    throw Object.assign(new Error(`未找到已安装的包：${packageName}`), { status: 404 })
  }
  const manifest = readJson(join(source, 'package.json'))
  const version = String(manifest?.version ?? 'unknown').replace(/[/\\]/g, '_')
  const slug = `${slugFor(packageName)}${version}`
  const target = join(ctx.home, 'workspace-orchestrator', 'disabled', slug)
  if (existsSync(target)) {
    throw Object.assign(new Error(`隔离目录已存在：${slug}（可能已被隔离过）`), { status: 409 })
  }

  // 先改 patch：DSH 启动时就不会再去 import 这个包。
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const sourceText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  // Appending a top-level `- id: <id>` + `disabled: true` shadows the earlier row:
  // patches apply in order, so the later entry wins (the orchestrator parser treats
  // both column-0 and column-4 rows as loader rows). A row without any id of its own
  // only appears in a hand-written patch; for it we anchor on the package name.
  const named = sourceText ? rowsIn(sourceText).filter((row) => row.name === packageName) : []
  const appendedRows = []
  const covered = new Set()
  let anchorId = null
  for (const row of named) {
    if (row.id) {
      if (covered.has(row.id)) continue
      covered.add(row.id)
      appendedRows.push(disableRow(row.id))
      continue
    }
    anchorId ??= packageName
    if (covered.has(anchorId)) continue
    covered.add(anchorId)
    appendedRows.push(`- id: ${anchorId}\n  name: ${packageName}\n  disabled: true\n`)
  }
  let appended = ''
  let backup = null
  if (appendedRows.length > 0) {
    const sep = sourceText.endsWith('\n') || sourceText === '' ? '' : '\n'
    appended = sep + appendedRows.join('')
    backup = copyBackup(patchFile)
    writeFileSync(patchFile, sourceText + appended, 'utf8')
  }
  const ids = [...covered]

  mkdirSync(target, { recursive: true })
  try {
    // rename keeps the code intact and is same-volume cheap; if the quarantine root
    // sits on another volume it fails with EXDEV and we fall back to copy+remove.
    try {
      renameSync(source, join(target, 'payload'))
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      cpSync(source, join(target, 'payload'), { recursive: true })
      rmSync(source, { recursive: true, force: true })
    }
  } catch (error) {
    // The move failed: put the patch back so the plugin stays consistent with disk.
    try {
      if (backup && existsSync(backup)) copyFileSync(backup, patchFile)
    } catch { /* best effort */ }
    rmSync(target, { recursive: true, force: true })
    throw Object.assign(new Error(`移动插件失败：${error?.message ?? error}`), { status: 500 })
  }

  writeFileSync(join(target, 'quarantine.json'), JSON.stringify({
    packageName,
    version,
    profile: ctx.profileName,
    originalPath: source,
    rows: ids,
    appended,
    anchorId,
    sourceText,
    patchBackup: backup,
    at: new Date().toISOString(),
  }, null, 2), 'utf8')

  return {
    packageName,
    version,
    slug,
    moved: true,
    rows: ids,
    patchBackup: backup,
    patchPatched: backup !== null,
  }
}

/** 恢复：移回原位 + 摘除我们追加的禁用行。 */
function restore(ctx, slug) {
  if (!isSafeSlug(slug)) {
    throw Object.assign(new Error(`非法的隔离记录名：${JSON.stringify(slug)}`), { status: 400 })
  }
  const target = join(ctx.home, 'workspace-orchestrator', 'disabled', slug)
  if (!isDir(target)) throw Object.assign(new Error(`隔离记录不存在：${slug}`), { status: 404 })
  const record = readJson(join(target, 'quarantine.json'))
  if (!record) throw Object.assign(new Error(`隔离记录已损坏：${slug}`), { status: 409 })
  if (record.kind === 'bundle') {
    throw Object.assign(new Error(`这是 bundle 记录，请用 bundle 恢复接口：${slug}`), { status: 409 })
  }

  const payload = join(target, 'payload')
  if (!isDir(payload)) throw Object.assign(new Error('隔离目录里没有 payload，无法恢复'), { status: 409 })

  // The recorded destination must still be inside this home's profiles tree:
  // a tampered record must not be able to move a directory anywhere else.
  const originalPath = String(record.originalPath ?? '')
  if (!isInside(join(ctx.home, 'profiles'), originalPath)) {
    throw Object.assign(new Error(`隔离记录里的原路径不在 profiles 目录内，已拒绝：${originalPath}`), { status: 409 })
  }
  if (existsSync(originalPath)) {
    throw Object.assign(new Error(`原位置已存在同名包：${originalPath}（请先处理冲突）`), { status: 409 })
  }

  mkdirSync(join(originalPath, '..'), { recursive: true })
  try {
    renameSync(payload, originalPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw Object.assign(new Error(`移回插件失败：${error?.message ?? error}`), { status: 500 })
    }
    cpSync(payload, originalPath, { recursive: true })
    rmSync(payload, { recursive: true, force: true })
  }

  const profileDir = join(ctx.home, 'profiles', record.profile ?? ctx.profileName)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  let revertedPatch = false
  let patchNote = null
  if (record.appended && existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const reverted = revertAppend(text, record)
    if (reverted.applied && reverted.text !== text) {
      copyBackup(patchFile)
      writeFileSync(patchFile, reverted.text, 'utf8')
      revertedPatch = true
    } else {
      // Files moved back but the disable row is gone/edited: say so instead of pretending.
      patchNote = `patch 里的禁用行已被改动（${reverted.reason ?? 'not-found'}），未自动修改；如插件仍被禁用，请手工删掉对应 "disabled: true" 行。`
    }
  }

  rmSync(target, { recursive: true, force: true })
  return { packageName: record.packageName, restoredTo: originalPath, revertedPatch, patchNote }
}

/* ------------------------------------------------------------------ HTML */

function html(token, profileName) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 急救 · ${profileName}</title>
<style>
  :root { color-scheme: light dark; --bd: rgba(127,127,127,.3); --bg: #fff; --fg: #1b1b1b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16181c; --fg: #e6e6e6; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
         font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { opacity: .65; font-size: 12px; margin-bottom: 18px; }
  section { border: 1px solid var(--bd); border-radius: 10px; margin-bottom: 18px; overflow: hidden; }
  header { padding: 10px 14px; border-bottom: 1px solid var(--bd); display: flex; gap: 10px; align-items: center; }
  header h2 { font-size: 14px; margin: 0; }
  .count { font-size: 12px; opacity: .65; }
  .body { padding: 12px 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 500; opacity: .6; padding: 6px 8px; border-bottom: 1px solid var(--bd); }
  td { padding: 8px; border-bottom: 1px solid var(--bd); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; opacity: .8; }
  button { cursor: pointer; border-radius: 6px; border: 1px solid var(--bd); background: transparent;
           color: inherit; padding: 4px 10px; font-size: 12px; }
  button:hover { background: rgba(127,127,127,.12); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .danger { border-color: rgba(200,60,60,.55); color: rgb(200,60,60); }
  .ok { border-color: rgba(46,160,90,.55); color: rgb(46,160,90); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .on { background: rgba(46,160,90,.16); color: rgb(46,160,90); }
  .off { background: rgba(140,140,140,.2); }
  .missing { background: rgba(200,60,60,.14); color: rgb(200,60,60); }
  .warn2 { background: rgba(200,140,40,.16); color: rgb(180,120,20); }
  .badge.bundle { background: rgba(70,120,220,.16); color: rgb(70,120,220); }
  .conflict { border-left: 3px solid rgb(200,60,60); padding: 8px 12px; margin-bottom: 8px;
              background: rgba(200,60,60,.07); border-radius: 6px; font-size: 13px; }
  .conflict.warn { border-left-color: rgb(200,140,40); background: rgba(200,140,40,.08); }
  .conflict b { display: block; margin-bottom: 2px; }
  #toast { position: fixed; right: 20px; bottom: 20px; max-width: 420px; padding: 10px 14px; border-radius: 8px;
           font-size: 13px; display: none; border: 1px solid var(--bd); background: var(--bg); }
  #toast.show { display: block; }
  #toast.ok { border-color: rgba(46,160,90,.6); color: rgb(46,160,90); }
  #toast.err { border-color: rgba(200,60,60,.6); color: rgb(200,60,60); }
  .empty { opacity: .6; font-size: 13px; }
  .loading { opacity: .6; font-size: 13px; }
</style></head>
<body>
<h1>DSH 急救面板</h1>
<div class="sub">profile <b>${profileName}</b> · 不依赖 DSH 进程 · 所有改动都会先备份</div>

<section>
  <header><h2>冲突告警</h2><span class="count" id="conflict-count">—</span></header>
  <div class="body" id="conflicts"><div class="loading">扫描中…</div></div>
</section>

<section>
  <header><h2>插件列表</h2><span class="count" id="plugin-count">—</span></header>
  <div class="body" id="plugins"><div class="loading">加载中…</div></div>
</section>

<section>
  <header><h2>已隔离备份</h2><span class="count" id="disabled-count">—</span></header>
  <div class="body" id="disabled"><div class="loading">加载中…</div></div>
</section>

<div id="toast"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let toastTimer = null;
function toast(kind, text) {
  const el = $('toast');
  el.className = 'show ' + kind;
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 5000);
}

async function api(path, body) {
  const init = { headers: { 'x-rescue-token': TOKEN, accept: 'application/json' } };
  if (body) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, init);
  let json = null;
  try { json = await res.json(); } catch { throw new Error('主机返回了非 JSON 响应（HTTP ' + res.status + '）'); }
  if (!res.ok || json.ok === false) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status));
  return json.value;
}

function renderConflicts(state) {
  const list = (state.conflicts || []).concat(state.warnings || []);
  $('conflict-count').textContent = (state.errorCount || 0) + ' 个错误 / ' + (state.warningCount || 0) + ' 个警告';
  const box = $('conflicts');
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">没有发现静态可判定的冲突。</div>';
    return;
  }
  box.innerHTML = list.map((item) =>
    '<div class="conflict' + (item.level === 'warning' ? ' warn' : '') + '">' +
    '<b>' + esc(item.code) + '</b>' + esc(item.message) + '</div>').join('');
}

function renderPlugins(state) {
  const rows = state.plugins || [];
  const bundleCount = rows.filter((p) => p.kind === 'bundle').length;
  $('plugin-count').textContent = rows.length + ' 个' + (bundleCount ? '（其中 bundle ' + bundleCount + ' 个）' : '');
  const box = $('plugins');
  if (rows.length === 0) { box.innerHTML = '<div class="empty">这个 profile 没有第三方插件。</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>插件</th><th>版本</th><th>状态</th><th>位置</th><th>操作</th></tr></thead><tbody>' +
    rows.map((p) => {
      const isBundle = p.kind === 'bundle';
      const status = p.quarantined ? '<span class="badge off">已隔离</span>'
        : p.missing ? '<span class="badge missing">包缺失</span>'
        : (!p.registered ? '<span class="badge warn2">未注册</span>'
          : (p.enabled ? '<span class="badge on">已启用</span>' : '<span class="badge off">已禁用</span>'));
      const kindBadge = isBundle ? ' <span class="badge bundle" title="通过 dsh.profile.bundles 加载，没有可移动的文件夹">bundle</span>' : '';
      const idHint = isBundle && !p.enabled && p.idGuess ? '<br><small class="warn2">id 为回退猜测</small>' : '';
      let action;
      if (p.missing) action = '<button class="danger" disabled>无法操作</button>';
      else if (p.quarantined) action = '<button disabled>已在隔离区</button>';
      else if (isBundle) {
        action = p.enabled
          ? '<button class="danger" data-bundle-disable="' + esc(p.name) + '">仅禁用</button> '
            + '<button class="danger" data-bundle-uninstall="' + esc(p.name) + '">彻底移除</button>'
          : '<button class="ok" data-bundle-restore-name="' + esc(p.name) + '">恢复启用</button>';
      } else {
        action = '<button class="danger" data-quarantine="' + esc(p.name) + '">禁用并隔离</button>';
      }
      return '<tr><td>' + esc(p.name) + kindBadge + idHint + '</td><td><code>' + esc(p.version || '—') + '</code></td>' +
        '<td>' + status + '</td><td><code>' + esc(p.location || (isBundle ? '（manifest 加载）' : '—')) + '</code></td>' +
        '<td>' + action + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderDisabled(state) {
  const rows = state.disabled || [];
  $('disabled-count').textContent = rows.length + ' 个';
  const box = $('disabled');
  if (rows.length === 0) { box.innerHTML = '<div class="empty">还没有被隔离的插件。</div>'; return; }
  box.innerHTML = '<table><thead><tr><th>插件</th><th>类型</th><th>版本</th><th>隔离时间</th><th>操作</th></tr></thead><tbody>' +
    rows.map((d) => {
      const isBundle = d.kind === 'bundle';
      const type = isBundle ? '<span class="badge bundle">bundle</span>' : '<span class="badge off">package</span>';
      // A bundle record has no payload to move back; it is restored through patch/manifest.
      const restorable = isBundle || d.payloadPresent;
      const button = restorable
        ? '<button class="ok" data-' + (isBundle ? 'bundle-restore' : 'restore') + '="' + esc(d.slug) + '">恢复</button>'
        : '<button disabled title="隔离目录里没有 payload">无法恢复</button>';
      return '<tr><td>' + esc(d.packageName) + '</td><td>' + type + '</td><td><code>' + esc(d.version || '—') + '</code></td>' +
        '<td><code>' + esc((d.at || '').replace('T', ' ').slice(0, 19)) + '</code></td>' +
        '<td>' + button + '</td></tr>';
    }).join('') + '</tbody></table>';
}

async function refresh() {
  try {
    const state = await api('/state');
    renderConflicts(state);
    renderPlugins(state);
    renderDisabled(state);
  } catch (error) {
    $('conflicts').innerHTML = '<div class="conflict"><b>无法读取状态</b>' + esc(error.message) + '</div>';
    $('plugins').innerHTML = '<div class="empty">—</div>';
    $('disabled').innerHTML = '<div class="empty">—</div>';
    toast('err', '读取失败：' + error.message);
  }
}

document.addEventListener('click', async (event) => {
  const quarantineBtn = event.target.closest('[data-quarantine]');
  const restoreBtn = event.target.closest('[data-restore]');
  const disableBtn = event.target.closest('[data-bundle-disable]');
  const uninstallBtn = event.target.closest('[data-bundle-uninstall]');
  const bundleRestoreBtn = event.target.closest('[data-bundle-restore]');
  const bundleEnableBtn = event.target.closest('[data-bundle-restore-name]');
  if (!quarantineBtn && !restoreBtn && !disableBtn && !uninstallBtn && !bundleRestoreBtn && !bundleEnableBtn) return;
  const btn = quarantineBtn || restoreBtn || disableBtn || uninstallBtn || bundleRestoreBtn || bundleEnableBtn;

  let prompt;
  let work;
  let label;
  if (quarantineBtn) {
    const name = quarantineBtn.getAttribute('data-quarantine');
    prompt = '确认隔离「' + name + '」？\\n\\n它会被移动到 disabled/ 目录，并在 patch 里写入禁用行（原文件已备份）。';
    label = '禁用并隔离';
    work = async () => {
      const r = await api('/quarantine', { packageName: name });
      return 'ok|' + name + ' 已隔离到 ' + r.slug + (r.patchPatched ? '（patch 已备份并写入 disabled: true）' : '（patch 里没有它的行，只移动了文件）');
    };
  } else if (restoreBtn) {
    const slug = restoreBtn.getAttribute('data-restore');
    prompt = '确认恢复「' + slug + '」？\\n\\n它会移回 node_modules，并从 patch 中移除禁用行。';
    label = '恢复';
    work = async () => {
      const r = await api('/restore', { slug });
      const patchPart = r.revertedPatch ? '（patch 已还原）' : '（patch 未改动）';
      return (r.patchNote ? 'err|' : 'ok|') + r.packageName + ' 已恢复' + patchPart + (r.patchNote ? '  ' + r.patchNote : '');
    };
  } else if (disableBtn) {
    const name = disableBtn.getAttribute('data-bundle-disable');
    prompt = '确认禁用 bundle「' + name + '」？\\n\\n它没有可移动的文件夹，因此会在 patch 末尾为它的每个真实入口 id 追加 disabled: true（patch 已自动备份）。';
    label = '仅禁用';
    work = async () => {
      const r = await api('/bundle-disable', { packageName: name, uninstall: false });
      const ids = (r.entryIds || []).join(', ');
      return (r.idGuess ? 'err|' : 'ok|') + name + ' 已禁用（入口 id: ' + ids + '）'
        + (r.note ? '  ' + r.note : '') + (r.patchPatched ? '，patch 已备份' : '');
    };
  } else if (uninstallBtn) {
    const name = uninstallBtn.getAttribute('data-bundle-uninstall');
    prompt = '确认彻底移除 bundle「' + name + '」？\\n\\n会做两件事：\\n1) 在 patch 里追加 disabled: true；\\n2) 从 package.json 的 dsh.profile.bundles 和 dependencies 中删除该包。\\n\\n两个文件都会先自动备份，panel 里可以一键恢复。';
    label = '彻底移除';
    work = async () => {
      const r = await api('/bundle-disable', { packageName: name, uninstall: true });
      return 'ok|' + name + ' 已彻底移除（patch 已禁用' + (r.uninstalled ? '，manifest 已摘除并备份' : '') + '）';
    };
  } else if (bundleRestoreBtn) {
    const slug = bundleRestoreBtn.getAttribute('data-bundle-restore');
    prompt = '确认恢复 bundle 记录「' + slug + '」？\\n\\n会移除 patch 里的禁用行，并把 manifest 里的条目加回去（如当时被移除过）。';
    label = '恢复';
    work = async () => {
      const r = await api('/bundle-restore', { slug });
      const parts = [];
      if (r.revertedPatch) parts.push('patch 已还原');
      if (r.restoredManifest) parts.push('manifest 已还原');
      return (r.patchNote ? 'err|' : 'ok|') + r.packageName + ' 已恢复（' + (parts.join('，') || '无改动') + '）'
        + (r.patchNote ? '  ' + r.patchNote : '');
    };
  } else {
    // Restore-enable straight from the plugin list: find the bundle's quarantine record.
    const name = bundleEnableBtn.getAttribute('data-bundle-restore-name');
    const state = await api('/state');
    const record = (state.disabled || []).find((d) => d.kind === 'bundle' && d.packageName === name);
    if (!record) { toast('err', '找不到 ' + name + ' 的 bundle 记录，请在「已隔离备份」里手工恢复。'); return; }
    prompt = '确认恢复启用 bundle「' + name + '」？';
    label = '恢复启用';
    btn.onclick = null;
    toast('ok', '正在恢复 ' + name + '…');
    try {
      btn.disabled = true;
      const r = await api('/bundle-restore', { slug: record.slug });
      toast(r.patchNote ? 'err' : 'ok', name + ' 已恢复启用' + (r.patchNote ? '  ' + r.patchNote : ''));
      await refresh();
    } catch (error) {
      toast('err', '操作失败：' + error.message);
      btn.disabled = false;
    }
    return;
  }

  if (!window.confirm(prompt)) return;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const outcome = await work();
    const idx = outcome.indexOf('|');
    toast(outcome.slice(0, idx), outcome.slice(idx + 1));
    await refresh();
  } catch (error) {
    toast('err', '操作失败：' + error.message);
    btn.disabled = false;
    btn.textContent = label;
  }
});

refresh();
</script>
</body></html>`
}

/* ---------------------------------------------------------------- server */

function tokenOk(req, url, token) {
  const given = req.headers['x-rescue-token'] ?? url.searchParams.get('token')
  return given === token
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error) }
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * @param {{ profileName: string, home?: string, port?: number, quiet?: boolean }} options
 */
export async function startRescueWeb(options) {
  const home = resolve(options.home ?? resolveDshHome())
  const profileName = String(options.profileName ?? '')
  // A profile name is one directory under <home>/profiles; refuse anything else.
  if (!isSafeSegment(profileName)) {
    throw Object.assign(new Error(`非法的 profile 名：${JSON.stringify(profileName)}`), { code: 'EDSH_BAD_PROFILE' })
  }
  const ctx = { home, profileName }
  const token = randomBytes(24).toString('base64url')

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      const pathname = url.pathname

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(html(token, ctx.profileName))
        return
      }
      if (!pathname.startsWith('/api/')) { sendJson(res, 404, { ok: false, error: { message: 'not found' } }); return }
      if (!tokenOk(req, url, token)) { sendJson(res, 403, { ok: false, error: { message: 'bad token' } }); return }

      if (pathname === '/api/state' && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: { message: 'use GET' } })
        return
      }
      if ((pathname === '/api/quarantine' || pathname === '/api/restore'
        || pathname === '/api/bundle-disable' || pathname === '/api/bundle-restore') && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { message: 'use POST' } })
        return
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, { ok: true, value: await buildState(ctx) })
        return
      }
      if (req.method === 'POST' && pathname === '/api/quarantine') {
        const body = await readBody(req)
        sendJson(res, 200, { ok: true, value: quarantine(ctx, String(body.packageName ?? '')) })
        return
      }
      if (req.method === 'POST' && pathname === '/api/restore') {
        const body = await readBody(req)
        sendJson(res, 200, { ok: true, value: restore(ctx, String(body.slug ?? '')) })
        return
      }
      if (req.method === 'POST' && pathname === '/api/bundle-disable') {
        const body = await readBody(req)
        sendJson(res, 200, {
          ok: true,
          value: disableBundle(ctx, String(body.packageName ?? ''), { uninstall: body.uninstall === true }),
        })
        return
      }
      if (req.method === 'POST' && pathname === '/api/bundle-restore') {
        const body = await readBody(req)
        sendJson(res, 200, { ok: true, value: restoreBundle(ctx, String(body.slug ?? '')) })
        return
      }
      sendJson(res, 404, { ok: false, error: { message: `unknown endpoint ${pathname}` } })
    } catch (error) {
      try {
        const status = Number.isInteger(error?.status) ? error.status : (/invalid JSON|too large/.test(String(error?.message)) ? 400 : 500)
        sendJson(res, status, { ok: false, error: { message: String(error?.message ?? error) } })
      } catch { /* socket gone */ }
    }
  })

  let port
  try {
    port = await listen(server, options.port ?? DEFAULT_PORT)
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    port = await listen(server, 0)
  }

  const url = `http://127.0.0.1:${port}/?token=${token}`
  return {
    url,
    port,
    token,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** 尽力打开系统默认浏览器；失败不影响服务。 */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}
