/**
 * `scan_conflicts` — static conflict scan over a profile's composed plugin rows.
 *
 * Nothing here executes plugin code. The composed row list comes from
 * `dsh <profile> --dump-config` when the CLI allows it, otherwise from the
 * profile's own `cordis.patch.yml` (with an explicit coverage note).
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { analyzeConflicts, collectFacts, parseRows } from '../conflict-scan.mjs';
import { parsePatchRows } from '../orchestrator-core/src/profile-patch.mjs';
import { resolveInstall, resolveDshHome } from '../orchestrator-core/src/paths.mjs';
import { runCli } from '../orchestrator-core/src/process.mjs';
import { resolveProfile } from '../profile.js';

/** Profiles the CLI refuses to load; scan their patch layer only. */
const CLI_REFUSED = new Set(['desktop']);

async function loadRows({ profileName, profileDir }) {
  const notes = [];
  const install = resolveInstall({});

  if (profileName && !CLI_REFUSED.has(profileName.toLowerCase())) {
    try {
      const dump = await runCli({
        exe: install.exe,
        cliJs: install.cliJs,
        args: [profileName, '--dump-config'],
        cwd: profileDir ?? resolveDshHome(),
        env: { DSH_HOME: resolveDshHome() },
        timeoutMs: 60_000,
      });
      const rows = parseRows(dump.stdout);
      if (rows.length > 0) return { rows, source: 'dump-config', notes };
      notes.push({ code: 'dump-empty', message: `--dump-config 没有返回任何行（exit=${dump.code}）。` });
    } catch (error) {
      notes.push({ code: 'dump-failed', message: `--dump-config 失败：${String(error?.message ?? error)}` });
    }
  } else if (profileName) {
    notes.push({
      code: 'cli-refused',
      message: `profile "${profileName}" 不能由 CLI 加载（desktop 由 Electron 独占），本次只扫描它自己的 patch 层。`,
    });
  }

  const patchFile = profileDir ? join(profileDir, 'cordis.patch.yml') : undefined;
  if (!patchFile || !existsSync(patchFile)) {
    notes.push({ code: 'no-patch-file', message: '找不到 profile 的 cordis.patch.yml。' });
    return { rows: [], source: 'none', notes };
  }
  const rows = parsePatchRows(readFileSync(patchFile, 'utf8')).map((row) => ({
    id: row.id,
    name: row.name,
    disabled: row.disabled === 'true',
    inject: [],
  }));
  notes.push({
    code: 'patch-only',
    message: '只扫描了 profile 自己的 patch 层；bundle 提供的行未纳入（CLI 无法组合该 profile）。',
  });
  return { rows, source: 'cordis.patch.yml', notes };
}

export function createConflictTool(ctx) {
  return {
  name: 'scan_conflicts',
  description:
    'Statically scan a DSH profile for plugin conflicts: duplicate loader entry ids, the same package inserted twice, '
    + 'two plugins providing the same service, injected services nobody provides, and service dependency cycles. '
    + 'Reads configuration and plugin source text only — plugin code is never executed. '
    + 'Tool-name collisions cannot be known statically and are reported as a note.',
  parameters: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'Profile name; defaults to the active profile.' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        profile: { oneOf: [{ type: 'null' }, { type: 'string' }] },
        profileDir: { oneOf: [{ type: 'null' }, { type: 'string' }] },
        source: { type: 'string' },
        rowsScanned: { type: 'number' },
        ok: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
        warnings: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
        notes: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    render: (_args, value) => {
      const lines = [`Conflict scan — ${value?.profile ?? '(active)'}  [${value?.source}]`];
      lines.push(`  rows: ${value?.rowsScanned ?? 0}   errors: ${value?.errors?.length ?? 0}   warnings: ${value?.warnings?.length ?? 0}`);
      for (const issue of value?.errors ?? []) lines.push(`  [error] ${issue.code}: ${issue.message}`);
      for (const issue of value?.warnings ?? []) lines.push(`  [warn ] ${issue.code}: ${issue.message}`);
      for (const note of value?.notes ?? []) lines.push(`  [note ] ${note.code}: ${note.message}`);
      if ((value?.errors?.length ?? 0) === 0) lines.push('  没有发现静态可判定的冲突。');
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args = {}) {
    // `profileContext` is the authoritative profile of the running host; the
    // environment/argv heuristic is only a fallback for harness calls.
    const fromContext = (() => {
      try { return ctx?.get?.('profileContext')?.name ?? undefined } catch { return undefined }
    })();
    const resolved = resolveProfile(process.env, { moduleDir: import.meta.dirname });
    const home = resolveDshHome();
    const explicit = typeof args.profile === 'string' && args.profile.trim().length > 0 ? args.profile.trim() : undefined;
    const profileName = explicit ?? fromContext ?? (resolved?.dir ? basename(resolved.dir) : undefined);
    const profileDir = profileName ? join(home, 'profiles', profileName) : (resolved?.dir ?? null);

    if (!profileName) {
      throw new Error('scan_conflicts: 无法确定 profile（既没有参数，也没有 profileContext / 可解析的环境）。');
    }

    const loaded = await loadRows({ profileName, profileDir });
    const facts = collectFacts(profileDir ?? '', loaded.rows);
    const report = analyzeConflicts({
      rows: loaded.rows,
      facts: facts.facts,
      unread: facts.unread,
      profileDir: profileDir ?? '',
    });

    return {
      profile: profileName,
      profileDir,
      source: loaded.source,
      rowsScanned: report.rowsScanned,
      ok: report.ok,
      errors: report.errors,
      warnings: report.warnings,
      notes: [...loaded.notes, ...report.notes],
    };
  },
  }
}

export const CONFLICT_TOOL = createConflictTool();

