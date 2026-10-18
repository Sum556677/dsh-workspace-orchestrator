/**
 * dsh-workspace-orchestrator — DSH plugin orchestration and workspace-isolation manager.
 *
 * Stage 1 (skeleton): this module registers exactly one capability, the `scan_plugins`
 * tool, and does nothing else. No HTTP routes, no services, no config mutation.
 *
 * Contract followed here (see the DSH 0.2.0-rc.2 loader/tools contracts):
 *  - Cordis plugin shape `name` / `inject` / `apply(ctx)`.
 *  - `apply()` only registers; it performs no IO that can fail and never throws, so a bad
 *    host environment degrades to "tool registered but reporting a diagnostic" instead of
 *    a failed fiber that could take the whole tree down.
 *  - No `@deepseek-ai/*` import. The tool registry accepts a plain definition object, so
 *    `defineTool` (a schema-compiler convenience from `@deepseek-ai/dsh-tools`) is not
 *    needed and is deliberately not imported.
 *  - Scanning runs inside `execute`, never during `apply()`.
 */

import { scanProfilePlugins } from './lib/scan.js';
import { INSTANCE_TOOLS, instanceSummary } from './lib/tools/instances.js';
import { WORKSPACE_SCOPE_TOOL, createWorkspaceScopeTool } from './lib/tools/workspace-scope.js';
import { CONFLICT_TOOL, createConflictTool } from './lib/tools/conflicts.js';
import { createDebugSingleModeTool } from './lib/tools/debug-single-mode.js';
import { createSingleMode, defaultMappingPath, readMapping, pathKey } from './lib/single-mode.mjs';
import { API_PREFIX, handleRequest } from './lib/rpc.js';

/** Log tag used for every diagnostic this plugin emits. */
const TAG = 'plugin-orchestrator';

/**
 * The stage-1 tool definition.
 *
 * Registered as a plain object rather than through `defineTool`: the registry's only
 * requirements are a name, a description, a supported-subset JSON Schema for `output`, an
 * `output.render`, and an `execute`. Keeping it plain avoids any `@deepseek-ai/*` import.
 *
 * The schema stays inside the enforced subset: `type` is always a single string, and a
 * nullable field is written as `oneOf: [null, <type>]` because type arrays are rejected.
 */
/** A nullable string, in the subset's only accepted form. */
const NULLABLE_STRING = { oneOf: [{ type: 'null' }, { type: 'string' }] };

const SCAN_PLUGINS_TOOL = {
  name: 'scan_plugins',
  description:
    'List the third-party plugins of the active DSH profile (read-only). Reads the profile manifest '
    + '(dsh.profile.bundles), the profile cordis.patch.yml patch layer, and resolvable package manifests to '
    + 'report each plugin\'s loader-entry id, package name, version, and effective enablement. Runtime bundles '
    + 'under @deepseek-ai/* are filtered out and only counted.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        profileDir: NULLABLE_STRING,
        runtimeVersion: NULLABLE_STRING,
        count: { type: 'number', description: 'Number of third-party plugins reported.' },
        officialFiltered: { type: 'number', description: 'Number of @deepseek-ai/* entries skipped.' },
        instances: {
          type: 'object',
          description: 'Isolated instances currently launched by this manager (from the orchestrator core registry).',
          properties: {
            count: { type: 'number', description: 'Registered instances.' },
            live: { type: 'number', description: 'Instances whose process is still alive.' },
            profiles: { type: 'array', description: 'Profile names of the live instances.', items: { type: 'string' } },
            error: { ...NULLABLE_STRING, description: 'Why the instance registry could not be read, if it could not.' },
          },
        },
        plugins: {
          type: 'array',
          description: 'One row per third-party plugin row.',
          items: {
            type: 'object',
            properties: {
              id: { ...NULLABLE_STRING, description: 'Loader entry id, when the row declares one.' },
              name: { ...NULLABLE_STRING, description: 'Package name of the plugin.' },
              version: { ...NULLABLE_STRING, description: 'Installed version, or null when unresolvable.' },
              enabled: { type: 'boolean', description: 'Effective enablement after the patch layer.' },
              source: { type: 'string', description: 'bundle | patch-insert | dependency | patch-override' },
            },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
  },
  async execute() {
    const report = await scanProfilePlugins({
      env: process.env,
      argv: process.argv,
      moduleDir: import.meta.dirname,
    });
    // Read-only and failure-tolerant: a broken instance registry must not break scanning.
    report.instances = await instanceSummary();
    return report;
  },
};

/**
 * Human-readable rendering of a scan report.
 * @param {any} value
 * @returns {string}
 */
function renderReport(value) {
  if (!value || typeof value !== 'object') return 'scan_plugins produced no report.';
  const lines = [];
  if (value.runtimeVersion) lines.push(`DSH runtime: ${value.runtimeVersion}`);
  lines.push(`Profile: ${value.profileDir ?? '(unresolved)'}${value.profileSource ? `  [${value.profileSource}]` : ''}`);
  const inst = value.instances;
  if (inst) {
    if (inst.error) lines.push(`Isolated instances: unavailable (${inst.error})`);
    else {
      const named = inst.profiles?.length ? ` — ${inst.profiles.join(', ')}` : '';
      lines.push(`Isolated instances: ${inst.count ?? 0} registered, ${inst.live ?? 0} alive${named}`);
    }
  }
  lines.push(
    `Third-party plugins: ${value.plugins?.length ?? 0}   (@deepseek-ai/* filtered: ${value.officialFiltered ?? 0})`,
  );
  lines.push('');
  if (!value.plugins || value.plugins.length === 0) {
    lines.push('No third-party plugins found for this profile.');
  } else {
    for (const p of value.plugins) {
      const id = p.id ? `id=${p.id}` : 'id=(none)';
      const name = p.name ?? '(unknown package)';
      const version = p.version ?? 'version unknown';
      lines.push(`${p.enabled ? '[on] ' : '[off]'} ${name} @ ${version}   ${id}   (${p.source})`);
      if (p.note) lines.push(`        note: ${p.note}`);
      if (p.loadState) lines.push(`        load state: ${p.loadState}`);
      if (p.bundleError) lines.push(`        bundle error: ${p.bundleError}`);
    }
  }
  if (value.diagnostics?.length) {
    lines.push('', 'Diagnostics:');
    for (const d of value.diagnostics) lines.push(`  - ${d}`);
  }
  if (value.notes?.length) {
    lines.push('', 'Notes:');
    for (const n of value.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}

/**
 * Cordis plugin name.
 * @type {string}
 */
export const name = 'pluginOrchestrator';

/**
 * Cordis 4 gates service access behind `inject`: reading `ctx.tools` without it throws
 * "cannot get property ... without inject". Declaring it also means that a host with no
 * tool registry leaves the plugin pending rather than failing to boot.
 * @type {string[]}
 */
export const inject = ['tools'];

/**
 * Build the tool definition. Exported so a harness test can exercise it without a Context.
 * @returns {object}
 */
export function buildScanPluginsTool() {
  return SCAN_PLUGINS_TOOL;
}

/**
 * The tool definition as lossless JSON, for tests that must feed the exact definition to
 * the real registry from a separate process.
 * @returns {string}
 */
export function scanPluginsToolJson() {
  return JSON.stringify(SCAN_PLUGINS_TOOL);
}

/**
 * The instance-management tool definitions (launch / list / stop), for harnesses
 * that exercise them without a Context.
 * @returns {object[]}
 */
export function buildInstanceTools() {
  return INSTANCE_TOOLS;
}

/** Every tool definition this plugin registers. */
export function allToolDefinitions() {
  return [SCAN_PLUGINS_TOOL, WORKSPACE_SCOPE_TOOL, CONFLICT_TOOL, ...INSTANCE_TOOLS];
}

/**
 * Register the orchestrator's capabilities.
 *
 * Never throws and performs no IO: every failure is logged and swallowed, so this plugin
 * can never be the reason a profile fails to boot.
 *
 * @param {any} ctx Cordis context
 * @returns {void}
 */
export function apply(ctx, config) {
  // Tools and single mode are independent: one failing must not cost the other.
  try {
    const tools = ctx?.tools;
    if (!tools || typeof tools.register !== 'function') {
      ctx?.logger?.warn?.(`${TAG}: ctx.tools is unavailable; no tools were registered`);
    } else {
      const definitions = [SCAN_PLUGINS_TOOL, createWorkspaceScopeTool(ctx), createConflictTool(ctx),
        createDebugSingleModeTool(ctx, { mappingPath: resolveMappingPath(config) }), ...INSTANCE_TOOLS];
      const registered = [];
      for (const definition of definitions) {
        // One bad tool must not cost the others their registration.
        try {
          tools.register(definition);
          registered.push(definition.name);
        } catch (error) {
          ctx?.logger?.warn?.(`${TAG}: failed to register ${definition.name}: ${error?.message ?? error}`);
        }
      }
      ctx?.logger?.info?.(`${TAG}: registered tools ${registered.join(', ')}`);
    }
  } catch (error) {
    // A boot must never fail because of this plugin.
    try {
      ctx?.logger?.warn?.(`${TAG}: failed to register tools: ${error?.message ?? error}`);
    } catch {
      /* even logging must not escape */
    }
  }

  // Hoisted so the settings API can drive the very same instance that listens for
  // session/created; two instances would fight over the same rows.
  let singleMode;
  /**
   * The outcome of starting single mode, reported to the panel. A silent `undefined`
   * here is indistinguishable from "never ran", so every path records why.
   * @type {{running: boolean, error: string|null, reason: string|null, mappingPath: string|null}}
   */
  const singleModeState = { running: false, error: null, reason: null, mappingPath: null };

  try {
    singleMode = startSingleMode(ctx, config);
    if (singleMode) {
      singleModeState.running = true;
      singleModeState.mappingPath = singleMode.mappingPath ?? null;
      ctx?.logger?.info?.(`${TAG}: single mode listening (mapping=${singleMode.mappingPath})`);
    } else {
      // startSingleMode returns undefined when config disables it (singleMode.enabled=false).
      singleModeState.reason = 'disabled by config (singleMode.enabled === false)';
      ctx?.logger?.warn?.(`${TAG}: single mode disabled by configuration; the workspace blacklist will not run`);
    }
  } catch (error) {
    const detail = error?.stack ?? String(error);
    singleModeState.error = String(error?.message ?? error);
    singleModeState.reason = 'initialization threw';
    // Never swallow this: a dead single mode means the blacklist silently does nothing.
    try {
      ctx?.logger?.error?.(`${TAG}: single mode FAILED to start: ${detail}`);
    } catch {
      /* logging must not escape */
    }
    try {
      ctx?.logger?.warn?.(`${TAG}: single mode FAILED to start: ${detail}`);
    } catch {
      /* logger variants differ between hosts */
    }
  }

  // Settings panel data route. Only web profiles have a webServer, so this is a
  // child inject: headless/tui profiles simply never mount it.
  try {
    let profileName;
    try {
      // Authoritative: the profile this process actually booted, not the launcher's env.
      profileName = ctx?.get?.('profileContext')?.name;
    } catch {
      profileName = undefined;
    }
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        try {
          // The mapping file single mode reads is the panel's source of truth for the
          // workspace view, so resolve it the same way the single-mode instance does.
          const mappingPath = resolveMappingPath(config);
          // Live rows: bundle-contributed entries never appear in the profile patch,
          // so the static scan alone cannot name them.
          const loaderRows = () => {
            try {
              const loader = ctx?.get?.('loader');
              if (!loader || typeof loader.entries !== 'function') return [];
              return [...loader.entries()].map((entry) => ({
                id: entry?.options?.id ?? null,
                name: entry?.options?.name ?? null,
                disabled: entry?.disabled === true,
              }));
            } catch {
              return [];
            }
          };
          // Same tool the agent uses, so the panel and the model share one implementation.
          const scopeTool = createWorkspaceScopeTool(ctx);
          scope.effect(() => scope.webServer.register({
            kind: 'prefix',
            path: API_PREFIX,
            handler: (req, res) => handleRequest(req, res, {
              moduleDir: import.meta.dirname,
              profileName,
              loaderRows,
              mappingPath,
              // One-row toggle: reads and writes the mapping in one pass instead of
              // replacing the whole list through `set`.
              writeMapping: async (file, workspaces) => {
                const { writeMapping } = await import('./lib/single-mode.mjs');
                return writeMapping(file, workspaces);
              },
              // Apply the blacklist to the live loader immediately, instead of waiting for
              // the next session/created. Uses the same instance that listens for sessions.
              singleModeStatus: () => ({
                running: Boolean(singleMode),
                error: singleModeState.error,
                reason: singleModeState.reason,
                mappingPath: singleModeState.mappingPath ?? resolveMappingPath(config),
                // Live view of the running instance, when there is one.
                status: singleMode?.status ?? null,
                detail: singleMode?.reason ?? null,
                workspace: singleMode?.activeWorkspace ?? null,
                debug: singleMode?.debug === true,
              }),
              // Toggle the verbose [single-mode DEBUG] trace on the live instance.
              setDebug: (on) => {
                if (!singleMode) return false;
                return singleMode.setDebug(on);
              },
              reconcileSingleMode: async (workspacePath) => {
                // Lazy fallback: if the boot-time instance is missing (an earlier failure,
                // or singleMode.enabled was toggled), try once more instead of reporting a
                // dead end the user cannot act on.
                if (!singleMode) {
                  try {
                    singleMode = startSingleMode(ctx, config);
                    if (singleMode) {
                      singleModeState.running = true;
                      singleModeState.error = null;
                      singleModeState.reason = 'started lazily on first use';
                      singleModeState.mappingPath = singleMode.mappingPath ?? null;
                      ctx?.logger?.info?.(`${TAG}: single mode started lazily (mapping=${singleMode.mappingPath})`);
                    }
                  } catch (error) {
                    const detail = error?.stack ?? String(error);
                    singleModeState.error = String(error?.message ?? error);
                    singleModeState.reason = 'lazy start threw';
                    try { ctx?.logger?.error?.(`${TAG}: single mode lazy start FAILED: ${detail}`); } catch { /* ignore */ }
                  }
                }
                if (!singleMode) {
                  return {
                    changed: [],
                    running: false,
                    failed: [{
                      id: '(single-mode)',
                      error: singleModeState.error
                        ? `single mode 无法启动：${singleModeState.error}`
                        : `single mode 未运行（${singleModeState.reason ?? 'unknown'}）`,
                    }],
                  };
                }
                const outcome = await singleMode.reconcileNow(workspacePath);
                return { ...outcome, running: true };
              },
              // Memory-only toggle: `Entry.update()` never calls `tree.write()`,
              // so the profile patch on disk is untouched and a restart restores it.
              toggleRow: async (id, enabled) => {
                const loader = ctx?.get?.('loader');
                if (!loader || typeof loader.entries !== 'function') {
                  throw Object.assign(new Error('loader is unavailable'), { status: 503 });
                }
                const entry = [...loader.entries()].find((row) => row?.options?.id === id);
                if (!entry) throw Object.assign(new Error(`no loader row with id ${id}`), { status: 404 });
                await entry.update({ disabled: enabled === false });
                return { id, enabled: entry.disabled !== true };
              },
              scopeTool,
              listInstances: async () => {
                const { Orchestrator } = await import('./lib/orchestrator-core/index.mjs');
                return new Orchestrator().list({ probe: true });
              },
              launchInstance: async (workspacePath, options) => {
                // Same sequence as the launch_workspace_instance tool: prepare, launch
                // (synchronous), wait for the URL, then detach so the pipes cannot keep
                // the host event loop alive.
                const { Orchestrator, detachInstance } = await import('./lib/orchestrator-core/index.mjs');
                const orchestrator = new Orchestrator();
                // A spawned instance must obey the same workspace blacklist as single mode,
                // otherwise "disabled in this workspace" would only hold inside the host.
                const blacklist = readWorkspaceBlacklist(mappingPath, workspacePath);
                const prepared = await orchestrator.prepare(workspacePath, {
                  shareData: options?.shareData === true,
                  blacklist,
                });
                const instance = orchestrator.launch(prepared);
                try {
                  const url = await orchestrator.awaitReady(instance, { timeoutMs: 90_000 });
                  const port = instance.registryRecord?.port ?? null;
                  detachInstance(instance);
                  return {
                    url,
                    profileName: prepared.profileName,
                    pid: typeof instance.pid === 'number' ? instance.pid : null,
                    workspacePath: prepared.workspacePath,
                    port: typeof port === 'number' ? port : null,
                    shareData: prepared.shareData === true,
                  };
                } catch (error) {
                  // Never leave a half-started instance behind when the URL never arrived.
                  try { await orchestrator.stop(instance); } catch { /* best effort */ }
                  throw error;
                }
              },
              stopInstance: async (target) => {
                const { Orchestrator } = await import('./lib/orchestrator-core/index.mjs');
                return new Orchestrator().stop(target);
              },
            }),
          }), 'workspace-orchestrator: settings api');
        } catch (error) {
          ctx?.logger?.warn?.(`${TAG}: failed to register ${API_PREFIX}: ${error?.message ?? error}`);
        }
      });
    }
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`${TAG}: settings api unavailable: ${error?.message ?? error}`);
    } catch {
      /* even logging must not escape */
    }
  }
}

/**
 * The blacklist a given workspace declares in the mapping file.
 *
 * Failures degrade to an empty list: a missing/unreadable mapping means "nothing is
 * disabled here", which matches the all-enabled default and never blocks a launch.
 * @param {string} mappingPath
 * @param {string} workspacePath
 * @returns {string[]}
 */
function readWorkspaceBlacklist(mappingPath, workspacePath) {
  try {
    const mapping = readMapping(mappingPath);
    if (mapping.error) return [];
    return mapping.workspaces.get(pathKey(workspacePath)) ?? [];
  } catch {
    return [];
  }
}

/**
 * The mapping file for this profile: an explicit config override, or the default
 * `$DSH_HOME/workspace-orchestrator/single-mode.json`. Shared by single mode and the
 * settings panel so the two can never disagree about which file is authoritative.
 * @param {any} [config]
 * @returns {string}
 */
function resolveMappingPath(config) {
  const settings = config?.singleMode ?? {};
  return typeof settings.mappingPath === 'string' && settings.mappingPath.length > 0
    ? settings.mappingPath
    : defaultMappingPath();
}

/**
 * Start the light single-open mode.
 * Registers one `session/created` listener and performs no IO; the mapping file is
 * read lazily on the first session, so boot cost stays negligible.
 *
 * Credentials come ONLY from the `config` argument `apply(ctx, config)` receives. Reading
 * `ctx.config` would throw `cannot get property "config" without inject`: Cordis gates
 * every undeclared property access on the context proxy, and `config` is not a service.
 *
 * @param {any} ctx Cordis context
 * @param {any} [config] plugin config (`{ singleMode: { enabled?, mappingPath? } }`)
 * @returns {ReturnType<typeof createSingleMode>|undefined}
 */
export function startSingleMode(ctx, config) {
  // Never touch ctx.config: it is gated by Cordis's inject proxy.
  const settings = config?.singleMode ?? {};
  if (settings.enabled === false) return undefined;
  const single = createSingleMode({
    ctx,
    // `settings` is ALREADY the unwrapped `singleMode` object, so read the override
    // directly — passing it to resolveMappingPath() would unwrap `.singleMode` a second
    // time and silently ignore a configured mappingPath.
    mappingPath: typeof settings.mappingPath === 'string' && settings.mappingPath.length > 0
      ? settings.mappingPath
      : defaultMappingPath(),
  });
  single.start();
  return single;
}



