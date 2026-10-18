/**
 * `scan_plugins` — the stage-1 capability of the orchestrator.
 *
 * It answers one question: **which third-party plugins does the active profile load, and
 * what is each one's id, name, version, and effective enablement?**
 *
 * Sources, all read-only:
 *   1. `<profile>/package.json` → `dsh.profile.bundles` is the ordered bundle selection,
 *      `dependencies` is what pnpm actually installed.
 *   2. `<profile>/cordis.patch.yml` → the user's own patch layer: `insert` rows add loader
 *      entries, id-targeted rows override or disable them.
 *   3. `ctx.get('pluginManager')` → optional. When the official manager service is mounted
 *      it supplies the runtime version and per-bundle load state. Its absence degrades the
 *      answer to "unknown" fields, never to an error.
 *
 * `@deepseek-ai/*` bundles are the runtime's own and are excluded from the third-party
 * list, as required; they are still counted so the report can state what was filtered.
 *
 * Nothing here writes, mounts, or mutates anything, and no part of it runs during `apply()`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { resolveProfile, readJson, dshHome } from './profile.js';
import { parsePatchYaml, projectPatchEntries } from './patch-yaml.js';

/** Prefix identifying the runtime's own bundles. */
const OFFICIAL_PREFIX = '@deepseek-ai/';

/**
 * Strip a subpath from a module specifier: `pkg/sub` → `pkg`, `@scope/pkg/sub` → `@scope/pkg`.
 * @param {string} specifier
 * @returns {string}
 */
export function packageNameOf(specifier) {
  const text = String(specifier ?? '').trim();
  if (text === '') return '';
  const parts = text.split('/');
  if (text.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : text;
  return parts[0];
}

/** Whether a specifier names one of the runtime's own packages. */
export function isOfficial(specifier) {
  return packageNameOf(specifier).startsWith(OFFICIAL_PREFIX);
}

/**
 * Locate the directory of the installed package providing a specifier, by walking up from
 * the resolved entry point to the nearest `package.json`.
 *
 * Uses `createRequire` against the *profile* directory so resolution follows the same
 * `node_modules` chain the Loader uses, without importing anything.
 *
 * @param {string} fromDir
 * @param {string} specifier
 * @returns {{dir: string, manifest: any}|null}
 */
function locatePackage(fromDir, specifier) {
  try {
    const require = createRequire(join(fromDir, 'noop.js'));
    let entry;
    try {
      entry = require.resolve(specifier);
    } catch {
      // A directory-style or extension-less specifier can still be resolved as a path.
      const guess = join(fromDir, 'node_modules', specifier, 'package.json');
      if (!existsSync(guess)) return null;
      entry = guess;
    }
    let dir = dirname(entry);
    for (let depth = 0; depth < 12; depth += 1) {
      const manifestPath = join(dir, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = readJson(manifestPath);
        if (manifest && typeof manifest === 'object') return { dir, manifest };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the DSH runtime version without importing anything from the installation.
 *
 * `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh` are versioned with the runtime, so their
 * manifests are authoritative — but the profile directory alone is usually not enough,
 * because official bundles live in the *dsh installation*, not the profile's `node_modules`.
 *
 * Resolution order, cheapest and most authoritative first:
 *
 *   1. `ctx.get('pluginManager').listBundles()` — the live service's own report;
 *   2. a `node_modules` lookup from the profile, then from the running launcher's directory;
 *   3. `process.execPath` (`<install>/DeepSeek Harness.exe`) → `<install>/resources/…`,
 *      covering the packaged Desktop carrier, whose manifests are readable through
 *      Electron's asar-aware `fs` when the plugin host runs there.
 *
 * Every step is individually guarded: an unreadable candidate simply yields the next one,
 * and an unresolved version is reported as `null` with a note rather than guessed.
 *
 * @param {string} profileDir
 * @param {string[]} notes collector for a human-readable trail
 * @param {any} pluginManager
 * @returns {Promise<string|null>}
 */
async function readRuntimeVersion(profileDir, notes, pluginManager) {
  // 1. The live manager service, when the host mounts it.
  if (pluginManager && typeof pluginManager.listBundles === 'function') {
    try {
      const bundles = await pluginManager.listBundles();
      if (Array.isArray(bundles)) {
        for (const want of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh']) {
          const hit = bundles.find((b) => b && b.name === want);
          if (hit && typeof hit.version === 'string' && hit.version.trim() !== '') return hit.version;
        }
      }
    } catch {
      /* optional enrichment only */
    }
  }

  // 2. Direct manifest lookups from the locations that can actually see the installation.
  const BUNDLE_SPECIFIERS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh'];
  const directCandidates = [];
  const pushDirect = (base, rel) => {
    if (typeof base === 'string' && base.trim() !== '') directCandidates.push(join(base, rel));
  };

  const launcher = process.argv?.[1];
  const launcherDir = typeof launcher === 'string' && launcher.trim() !== '' ? dirname(resolve(launcher)) : null;

  // A launcher inside a `node_modules` tree: walk up looking for a runtime-versioned manifest.
  if (launcherDir) {
    let dir = launcherDir;
    for (let depth = 0; depth < 10; depth += 1) {
      pushDirect(dir, 'dsh/package.json');
      pushDirect(dir, 'package.json');
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const execPath = process.execPath;
  if (typeof execPath === 'string' && execPath.trim() !== '') {
    const installRoot = dirname(resolve(execPath));
    const resources = join(installRoot, 'resources');
    const runtimeBase = join(resources, 'app.asar.unpacked', 'dsh');
    // Each direct candidate is a *directory*; `join(candidate, 'package.json')` below reads
    // the manifest, so a `node_modules` member is joined without the manifest suffix.
    for (const specifier of BUNDLE_SPECIFIERS) {
      pushDirect(join(runtimeBase, 'node_modules'), specifier);
    }
    pushDirect(runtimeBase, '');
    pushDirect(join(resources, 'app.asar.unpacked'), 'dsh-desktop-runtime');
    pushDirect(resources, '');
  }

  for (const candidate of directCandidates) {
    const manifest = readJson(join(candidate, 'package.json'));
    if (!manifest || typeof manifest.version !== 'string' || manifest.version.trim() === '') continue;
    const pkgName = typeof manifest.name === 'string' ? manifest.name : '';
    // Only a runtime-versioned manifest counts. An arbitrary package.json found while
    // walking up would otherwise report an unrelated project's version.
    if (pkgName === '@deepseek-ai/dsh-base' || pkgName === '@deepseek-ai/dsh'
      || pkgName === '@deepseek-ai/dsh-desktop-runtime' || pkgName === '@deepseek-ai/dsh-desktop') {
      return manifest.version;
    }
  }

  // 3. A `node_modules` resolution from the profile (covers a CLI-installed, per-profile
  //    manager whose profile carries its own official packages).
  for (const specifier of BUNDLE_SPECIFIERS) {
    const found = locatePackage(profileDir, specifier);
    if (found && typeof found.manifest.version === 'string') return found.manifest.version;
  }

  if (notes) {
    notes.push(
      'DSH runtime version could not be read from the installation; `pluginManager.listBundles()` was also unavailable.',
    );
  }
  return null;
}

/**
 * Optionally read `pluginManager.listBundles()` for live load state.
 * Every field is treated as untrusted: this is an optional service and its shape may change.
 *
 * @param {any} pluginManager
 * @returns {Promise<Map<string, {version: string|null, enabled: boolean|null, state: string|null, error: string|null}>>}
 */
async function readLiveBundles(pluginManager) {
  const out = new Map();
  if (!pluginManager || typeof pluginManager.listBundles !== 'function') return out;
  try {
    const bundles = await pluginManager.listBundles();
    if (!Array.isArray(bundles)) return out;
    for (const bundle of bundles) {
      if (!bundle || typeof bundle.name !== 'string') continue;
      out.set(bundle.name, {
        version: typeof bundle.version === 'string' ? bundle.version : null,
        enabled: typeof bundle.enabled === 'boolean' ? bundle.enabled : null,
        state: typeof bundle.state === 'string' ? bundle.state : null,
        error: bundle.error ? String(bundle.error) : null,
      });
    }
  } catch {
    /* optional enrichment only */
  }
  return out;
}

/**
 * Read the loader-entry rows a bundle's own patch file declares.
 *
 * A row's `name` may carry a subpath (`pkg/sub`); the package name is what matters for
 * attribution. Rows whose package is the bundle itself are the bundle's own entries.
 *
 * @param {string} pkgDir
 * @param {any} manifest
 * @returns {{patchFile: string|null, rows: Array<{id: string|null, name: string|null, disabled: boolean, $conditional: boolean}>}|null}
 */
function readBundlePatch(pkgDir, manifest) {
  try {
    const declared = manifest?.dsh?.bundle?.patch;
    if (typeof declared !== 'string' || declared.trim() === '') return null;
    const patchFile = isAbsolute(declared) ? declared : resolve(pkgDir, declared);
    if (!existsSync(patchFile)) {
      return { patchFile, rows: [], unreadable: true };
    }
    const parsed = parsePatchYaml(readFileSync(patchFile, 'utf8'));
    const { inserts } = projectPatchEntries(parsed.entries);
    return { patchFile, rows: inserts };
  } catch {
    return null;
  }
}

/**
 * Build the full third-party plugin report for a profile.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string[]} [options.argv]
 * @param {string|null} [options.hmrBaseDir]
 * @param {string|null} [options.moduleDir]
 * @param {any} [options.pluginManager]
 * @returns {Promise<object>}
 */
export async function scanProfilePlugins(options = {}) {
  const env = options.env ?? process.env;
  const notes = [];

  const profile = resolveProfile(env, {
    argv: options.argv ?? process.argv,
    hmrBaseDir: options.hmrBaseDir ?? null,
    moduleDir: options.moduleDir ?? null,
  });

  if (!profile.valid || !profile.dir) {
    return {
      profileDir: null,
      profileSource: profile.source,
      profileResolved: false,
      runtimeVersion: null,
      bundles: [],
      plugins: [],
      count: 0,
      officialFiltered: 0,
      diagnostics: [
        'Could not resolve the active profile directory: no candidate contained a package.json with dsh.profile.',
        `Candidates tried: ${profile.tried.map((t) => `${t.dir} (${t.source})`).join('; ') || 'none'}`,
      ],
      notes,
      generatedAt: new Date().toISOString(),
      dshHome: dshHome(env),
    };
  }

  const profileDir = profile.dir;
  const manifest = readJson(join(profileDir, 'package.json'));
  const diagnostics = [];

  const bundleNames = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((b) => typeof b === 'string' && b.trim() !== '')
    : [];
  if (bundleNames.length === 0) {
    notes.push('The profile manifest declares no dsh.profile.bundles; only patch-layer entries can appear.');
  }

  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object'
    ? Object.keys(manifest.dependencies)
    : [];

  // ---- the user's own patch layer -----------------------------------------
  const profilePatchFile = join(profileDir, 'cordis.patch.yml');
  let patchInserts = [];
  let patchOverrides = [];
  if (existsSync(profilePatchFile)) {
    const parsed = parsePatchYaml(readFileSync(profilePatchFile, 'utf8'));
    for (const d of parsed.diagnostics) diagnostics.push(`cordis.patch.yml: ${d}`);
    const projected = projectPatchEntries(parsed.entries);
    patchInserts = projected.inserts;
    patchOverrides = projected.overrides;
  } else {
    notes.push('No cordis.patch.yml in the profile directory.');
  }

  /** Disable state per loader-entry id from id-targeted rows; last row wins. */
  const disabledById = new Map();
  for (const row of patchOverrides) {
    if (row.id) disabledById.set(row.id, row);
  }

  const live = await readLiveBundles(options.pluginManager);

  // ---- assemble -----------------------------------------------------------
  /** @type {Map<string, any>} keyed by loader-entry id (or package name as fallback). */
  const byEntryId = new Map();
  let officialFiltered = 0;

  const addPlugin = (record) => {
    const key = record.id ?? record.name;
    if (!key) return;
    const existing = byEntryId.get(key);
    if (!existing) {
      byEntryId.set(key, record);
      return;
    }
    // Merge: a patch insert refines the package-level record rather than duplicating it.
    if (existing.name === record.name || record.name === null) {
      byEntryId.set(key, { ...existing, ...record, id: existing.id ?? record.id });
    } else {
      byEntryId.set(key, record);
    }
  };

  // (a) selected bundles
  for (const bundleName of bundleNames) {
    if (isOfficial(bundleName)) {
      officialFiltered += 1;
      continue;
    }
    const found = locatePackage(profileDir, bundleName);
    const liveRow = live.get(bundleName) ?? null;
    addPlugin({
      id: null,
      name: bundleName,
      version: found?.manifest?.version ?? liveRow?.version ?? null,
      enabled: true,
      source: 'bundle',
      loadState: liveRow?.state ?? null,
      bundleError: liveRow?.error ?? null,
      viaPatch: false,
      note: found ? null : 'selected in dsh.profile.bundles but not resolvable from the profile',
    });
  }

  // (b) patch-layer insert rows
  for (const row of patchInserts) {
    const pkg = row.name ?? null;
    if (pkg === null && row.id === null) continue;
    const pkgName = pkg ? packageNameOf(pkg) : null;
    if (pkgName && isOfficial(pkgName)) {
      officialFiltered += 1;
      continue;
    }
    const found = pkg ? locatePackage(profileDir, pkgName) : null;
    const override = row.id ? disabledById.get(row.id) : undefined;
    const disabled = row.disabled || Boolean(override && override.disabled);
    addPlugin({
      id: row.id,
      name: pkgName,
      version: found?.manifest?.version ?? null,
      enabled: !disabled,
      source: 'patch-insert',
      loadState: null,
      bundleError: null,
      viaPatch: true,
      note: found ? null : 'inserted by cordis.patch.yml but not resolvable from the profile',
    });
  }

  // (c) installed dependencies carrying a dsh bundle patch but not selected as bundles
  for (const dep of dependencies) {
    if (isOfficial(dep)) continue;
    if (byEntryId.size > 0 && [...byEntryId.values()].some((p) => p.name === dep)) continue;
    const found = locatePackage(profileDir, dep);
    if (!found) continue;
    const isBundle = Boolean(found.manifest?.dsh?.bundle?.patch);
    if (!isBundle) continue;
    const bundlePatch = readBundlePatch(found.dir, found.manifest);
    addPlugin({
      id: null,
      name: dep,
      version: found.manifest.version ?? null,
      enabled: false,
      source: 'dependency',
      loadState: null,
      bundleError: null,
      viaPatch: false,
      note: 'installed and declares dsh.bundle.patch, but is not in dsh.profile.bundles (its rows are not loaded)',
      declaresRows: bundlePatch ? bundlePatch.rows.length : 0,
    });
  }

  // (d) id-targeted rows that disable an entry with no other record
  for (const row of patchOverrides) {
    if (!row.id || !row.name) continue;
    if (isOfficial(row.name)) continue;
    if (byEntryId.has(row.id)) continue;
    addPlugin({
      id: row.id,
      name: packageNameOf(row.name),
      version: locatePackage(profileDir, packageNameOf(row.name))?.manifest?.version ?? null,
      enabled: !row.disabled,
      source: 'patch-override',
      loadState: null,
      bundleError: null,
      viaPatch: true,
      note: 'targeted by cordis.patch.yml only',
    });
  }

  const plugins = [...byEntryId.values()].sort((a, b) => {
    const an = a.name ?? '';
    const bn = b.name ?? '';
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  const runtimeVersion = await readRuntimeVersion(profileDir, notes, options.pluginManager);

  return {
    profileDir,
    profileSource: profile.source,
    profileResolved: true,
    runtimeVersion,
    bundles: bundleNames,
    plugins,
    count: plugins.length,
    officialFiltered,
    diagnostics,
    notes,
    generatedAt: new Date().toISOString(),
    dshHome: dshHome(env),
  };
}
