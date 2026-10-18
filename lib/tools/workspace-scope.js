/**
 * `manage_workspace_scope` — read/write the single-mode workspace→plugin **blacklist**.
 *
 * Semantics: plugins are ON by default (that is what the native profile already says).
 * This tool records per-workspace *exclusions* — "in this workspace, do not run these
 * rows". `action="set"` therefore means "disable exactly these in that workspace", and
 * the tool description spells that out so the model phrases it correctly.
 *
 * This is the only writer of `single-mode.json`. It never touches a profile patch.
 */

import { readMapping, writeMapping, defaultMappingPath, pathKey, isProtectedId } from '../single-mode.mjs';
import { packageNameOf } from '../scan.js';

/**
 * Resolve package names to loader row ids using the live tree.
 * Returns `unsupported` when there is no loader (e.g. a direct harness call).
 */
function resolveNames(ctx, names) {
  if (!names || names.length === 0) return { resolved: [], unknown: [], ambiguous: {} };
  let entries;
  try {
    const loader = ctx?.get?.('loader');
    if (!loader || typeof loader.entries !== 'function') {
      return { unsupported: true, resolved: [], unknown: [], ambiguous: {} };
    }
    entries = [...loader.entries()];
  } catch {
    return { unsupported: true, resolved: [], unknown: [], ambiguous: {} };
  }

  const resolved = [];
  const unknown = [];
  const ambiguous = {};
  for (const name of names) {
    const ids = [...new Set(entries
      .filter((entry) => {
        const specifier = entry?.options?.name;
        if (typeof specifier !== 'string') return false;
        return specifier === name || packageNameOf(specifier) === name;
      })
      .map((entry) => entry?.options?.id)
      .filter(Boolean))];
    if (ids.length === 0) unknown.push(name);
    else if (ids.length > 1) ambiguous[name] = ids;
    else resolved.push({ name, id: ids[0] });
  }
  return { resolved, unknown, ambiguous };
}

export function createWorkspaceScopeTool(ctx) {
  return {
  name: 'manage_workspace_scope',
  description:
    'Manage the per-workspace plugin BLACKLIST for light single-open mode. '
    + 'Plugins are ENABLED by default (whatever the native profile says); this tool records which rows must NOT run '
    + 'in a given workspace. action="set" replaces that workspace\'s blacklist with the given loader-entry ids '
    + '(so "disable X in D:\\novels" => set workspacePath=D:\\novels, pluginRowIds=[X]); '
    + 'action="remove" drops the whole workspace entry (back to all-enabled); action="list" shows the current blacklists. '
    + 'Writes only the orchestrator mapping file — never a profile patch.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'remove', 'list'] },
      workspacePath: { type: 'string', description: 'Absolute workspace path (required for set/remove).' },
      pluginRowIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Loader-entry ids to DISABLE in this workspace (the blacklist for action="set").',
      },
      pluginNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Package names to disable (e.g. "dsh-novel-writer"); resolved to row ids against the live loader tree.',
      },
      mappingPath: { type: 'string', description: 'Override the mapping file location (advanced/testing).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        mappingPath: { type: 'string' },
        // The DSH schema subset only accepts a BOOLEAN here; an object form makes
        // tools.register() throw, which silently drops the whole tool.
        workspaces: { type: 'object', additionalProperties: true },
        changed: { type: 'boolean' },
        unknownIds: { type: 'array', items: { type: 'string' } },
        unknownNames: { type: 'array', items: { type: 'string' } },
        resolved: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } } } },
        ambiguous: { type: 'object', additionalProperties: true },
        message: { type: 'string' },
      },
    },
    render: (_args, value) => {
      const rows = Object.entries(value?.workspaces ?? {});
      const lines = [`Workspace blacklist (${value?.action}) — ${value?.mappingPath}`];
      if (rows.length === 0) lines.push('  (empty — every workspace runs all plugins)');
      for (const [workspace, record] of rows) {
        const ids = Array.isArray(record) ? record : record?.disabledPlugins ?? [];
        lines.push(`  ${workspace} -> disabled: ${ids.length ? ids.join(', ') : '(none)'}`);
      }
      for (const entry of value?.resolved ?? []) lines.push(`  resolved: ${entry.name} -> ${entry.id}`);
      if (value?.message) lines.push(`  ${value.message}`);
      for (const [name, ids] of Object.entries(value?.ambiguous ?? {})) lines.push(`  AMBIGUOUS ${name}: ${ids.join(', ')}`);
      if (value?.unknownNames?.length) lines.push(`  UNKNOWN names: ${value.unknownNames.join(', ')}`);
      if (value?.changed === false) lines.push('  (not written)');
      if (value?.unknownIds?.length) {
        lines.push(`  WARNING: no loader row with id(s): ${value.unknownIds.join(', ')}`);
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(args = {}) {
    const action = String(args.action ?? '').trim();
    if (!['set', 'remove', 'list'].includes(action)) {
      throw new Error('manage_workspace_scope: `action` must be one of set | remove | list');
    }
    const mappingPath = typeof args.mappingPath === 'string' && args.mappingPath.length > 0
      ? args.mappingPath
      : defaultMappingPath();

    const current = readMapping(mappingPath);
    const workspaces = { ...(current.raw ?? {}) };

    if (action === 'list') {
      return { action, mappingPath, workspaces, changed: false };
    }

    const workspace = String(args.workspacePath ?? '').trim();
    if (workspace.length === 0) {
      throw new Error(`manage_workspace_scope: \`workspacePath\` is required for action "${action}"`);
    }
    const key = pathKey(workspace);

    if (action === 'remove') {
      const existing = Object.keys(workspaces).find((candidate) => pathKey(candidate) === key);
      if (existing === undefined) {
        return { action, mappingPath, workspaces, changed: false };
      }
      delete workspaces[existing];
      writeMapping(mappingPath, workspaces);
      return { action, mappingPath, workspaces, changed: true };
    }

    const explicitIds = Array.isArray(args.pluginRowIds) ? args.pluginRowIds : undefined;
    const names = Array.isArray(args.pluginNames) ? args.pluginNames.filter((n) => typeof n === 'string' && n.length > 0) : [];
    if (!explicitIds && names.length === 0) {
      throw new Error('manage_workspace_scope: pass `pluginRowIds` and/or `pluginNames` for action "set"');
    }

    // Resolve package names against the live loader tree: users say "dsh-novel-writer",
    // not the row id. Ambiguity or a miss must stop the write so the agent can ask.
    const resolution = resolveNames(ctx, names);
    if (resolution.unsupported) {
      return {
        action, mappingPath, workspaces, changed: false,
        unknownNames: names, ambiguous: {}, unsupported: true,
        message: 'pluginNames 需要在运行中的 DSH 进程里解析（loader 树不可用）',
      };
    }
    if (resolution.unknown.length > 0 || Object.keys(resolution.ambiguous).length > 0) {
      return {
        action, mappingPath, workspaces, changed: false,
        unknownNames: resolution.unknown,
        ambiguous: resolution.ambiguous,
        resolved: resolution.resolved,
        message: '存在无法唯一确定的包名，未写入；请让用户确认具体插件。',
      };
    }

    const ids = [...(explicitIds ?? []), ...resolution.resolved.map((entry) => entry.id)];
    const cleaned = [...new Set(ids.map((id) => String(id).trim()).filter((id) => id.length > 0))];
    // Never let an agent disable the orchestrator itself.
    const protectedIds = cleaned.filter((id) => isProtectedId(id));
    if (protectedIds.length > 0) {
      return {
        action, mappingPath, workspaces, changed: false,
        message: `${protectedIds.join(', ')} 是编排器自身，不能加入黑名单（会停掉管理它的引擎）；已拒绝写入。`,
      };
    }

    // Replace the entry case/separator-insensitively so we never accumulate duplicates.
    const existing = Object.keys(workspaces).find((candidate) => pathKey(candidate) === key);
    if (existing !== undefined) delete workspaces[existing];
    // Store one canonical spelling (forward slashes, no trailing slash) for readability,
    // and the v2 blacklist record: these ids are the ones DISABLED in this workspace.
    workspaces[workspace.replace(/\\/g, '/').replace(/\/+$/, '')] = { disabledPlugins: cleaned };

    // A typo in an id would make single mode silently do nothing, so flag ids that
    // match no row in the live loader tree. Best-effort: never fail the write.
    let unknownIds = [];
    try {
      const loader = ctx?.get?.('loader');
      if (loader && typeof loader.entries === 'function') {
        const known = new Set([...loader.entries()].map((entry) => entry?.options?.id).filter(Boolean));
        unknownIds = cleaned.filter((id) => !known.has(id));
      }
    } catch { /* validation is best-effort */ }

    writeMapping(mappingPath, workspaces);
    return { action, mappingPath, workspaces, changed: true, unknownIds, resolved: resolution.resolved };
  },
  }
}

export const WORKSPACE_SCOPE_TOOL = createWorkspaceScopeTool()


