/**
 * Profile-directory discovery for the orchestrator.
 *
 * The hard part is finding the *active* profile directory from inside the host process.
 * The lessons here are taken from the shipped `dsh-compat-market` plugin, which documents
 * why the obvious answers are wrong:
 *
 *  - `DSH_PROFILE_DIR` / `DSH_PROFILE` are injected into **tool subprocess** environments
 *    (`dshEnvironment.collect`) and are therefore visible to a shell but may be absent in
 *    the host process. They are still the cheapest first guess.
 *  - The launcher receives the profile either positionally (the Electron desktop host is
 *    started as `... <asar>/dsh <profileDir>`) or as `dsh --profile <name>`, so
 *    `process.argv` is an authoritative in-process signal available immediately.
 *  - `hmr.baseDir` is a real public field but may be `undefined` during `apply()`.
 *
 * Every candidate is validated structurally before use: a real profile directory contains a
 * `package.json` whose `dsh.profile` field exists. A wrong guess therefore degrades to an
 * explicit "unresolved" answer instead of scanning an unrelated tree.
 *
 * Zero third-party imports; only `node:fs` / `node:path` / `node:os`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** How far up from this module's own directory to look for a profile. */
const MAX_WALK_UP = 8;

/**
 * Read and parse a JSON document, returning null for every failure.
 * @param {string} file
 * @returns {any|null}
 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a directory is a DSH profile.
 *
 * The discriminator is `dsh.profile` in its manifest: a profile's `package.json` carries the
 * ordered bundle list. Launcher paths do not have that field, so they are rejected.
 * @param {unknown} dir
 * @returns {boolean}
 */
export function isProfileDir(dir) {
  try {
    if (typeof dir !== 'string' || dir.trim() === '') return false;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    const manifest = readJson(join(dir, 'package.json'));
    return Boolean(manifest && typeof manifest === 'object' && manifest.dsh && manifest.dsh.profile);
  } catch {
    return false;
  }
}

/**
 * Candidate profile directories, best first, in order of trustworthiness.
 * @param {NodeJS.ProcessEnv} env
 * @param {{hmrBaseDir?: string|null, argv?: string[], moduleDir?: string|null}} [options]
 * @returns {Array<{dir: string, source: string}>}
 */
function candidates(env, options) {
  const found = [];
  const push = (dir, source) => {
    if (typeof dir === 'string' && dir.trim() !== '') found.push({ dir: resolve(dir), source });
  };

  // 1. An explicit environment override, which also covers future launchers.
  push(env.DSH_PROFILE_DIR, 'env:DSH_PROFILE_DIR');

  // 2. The launcher's own arguments, scanned last-first: the profile trails the launcher paths.
  const argv = options.argv ?? [];
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const name = arg === '--profile' ? argv[index + 1] : arg.slice('--profile='.length);
      if (typeof name === 'string' && name.trim() !== '') {
        push(join(dshHome(env), 'profiles', name), 'argv:--profile');
      }
      continue;
    }
    // A flag is never a path; resolving one would only produce a confusing cwd-relative entry.
    if (arg.startsWith('-')) continue;
    push(arg, `argv[${index}]`);
  }

  // 3. The `hmr` service exposes the base directory it resolves module watch roots against.
  push(options.hmrBaseDir ?? null, 'service:hmr.baseDir');

  // 4. The name-based form, for a host that does export the profile name.
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '') {
    push(join(dshHome(env), 'profiles', env.DSH_PROFILE), 'env:DSH_PROFILE');
  }

  // 5. Walk up from this module's own location, which lands on the profile for any normal
  //    install whose real path is inside the profile (pnpm, including its virtual store).
  if (options.moduleDir) {
    let dir = resolve(options.moduleDir);
    for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
      push(dir, `walk-up[${depth}]`);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return found;
}

/**
 * The DSH home directory.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function dshHome(env) {
  const home = env.DSH_HOME;
  return typeof home === 'string' && home.trim() !== '' ? resolve(home) : join(homedir(), '.dsh');
}

/**
 * Resolve the active profile directory, with the evidence for the answer.
 *
 * Never throws: an unresolved profile is reported explicitly so the caller can degrade
 * instead of guessing.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{hmrBaseDir?: string|null, argv?: string[], moduleDir?: string|null}} [options]
 * @returns {{dir: string|null, source: string, valid: boolean, tried: Array<{dir: string, source: string, valid: boolean}>}}
 */
export function resolveProfile(env = process.env, options = {}) {
  const tried = candidates(env, options).map((candidate) => ({
    ...candidate,
    valid: isProfileDir(candidate.dir),
  }));

  const winner = tried.find((candidate) => candidate.valid);
  if (winner) return { dir: winner.dir, source: winner.source, valid: true, tried };

  // Nothing validated. Report the miss rather than silently writing into the DSH home.
  return { dir: null, source: 'unresolved', valid: false, tried };
}
