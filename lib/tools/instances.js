/**
 * Instance-management tools: thin bridges over `lib/orchestrator-core`.
 *
 * Every rule of behaviour lives in the core. These definitions only translate
 * tool arguments into core calls and render the result, so the plugin never
 * grows a second implementation of profile/patch/process handling.
 */

/** Nullable string, in the schema subset's only accepted form. */
const NULLABLE_STRING = { oneOf: [{ type: 'null' }, { type: 'string' }] };

const LAUNCH_TOOL = {
  name: 'launch_workspace_instance',
  description:
    'Launch an isolated DSH instance for a workspace and return its URL. Creates (or reuses) a one-shot '
    + 'profile, isolates sessions/storages unless shareData is true, starts the official CLI with an '
    + 'OS-assigned port, and waits until it reports its URL. Long-running: the instance keeps running '
    + 'after this tool returns and must be closed with stop_workspace_instance.',
  parameters: {
    type: 'object',
    properties: {
      workspacePath: { type: 'string', description: 'Absolute path of the workspace to isolate.' },
      name: { oneOf: [{ type: 'null' }, { type: 'string' }], description: 'Optional profile name; derived from the path when omitted.' },
      shareData: { type: 'boolean', description: 'Share the host sessions/storages instead of isolating them. Default false.' },
      maxInstances: { type: 'number', description: 'Concurrent instance cap (default 5).' },
      timeoutMs: { type: 'number', description: 'How long to wait for the URL (default 90000).' },
    },
    required: ['workspacePath'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        profileName: { type: 'string' },
        pid: { type: 'number' },
        workspacePath: { type: 'string' },
        port: { oneOf: [{ type: 'null' }, { type: 'number' }] },
        shareData: { type: 'boolean' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: `Workspace instance ready\n  profile : ${value?.profileName}\n  pid     : ${value?.pid}\n  url     : ${value?.url}\n  data    : ${value?.shareData ? 'shared with host' : 'isolated'}`,
    }],
  },
  async execute(args = {}) {
    const { Orchestrator, detachInstance } = await import('../orchestrator-core/index.mjs');
    const { readMapping, defaultMappingPath, pathKey } = await import('../single-mode.mjs');
    const orchestrator = new Orchestrator(args.maxInstances ? { maxInstances: args.maxInstances } : undefined);
    // Honour the workspace blacklist so an instance launched by the agent obeys the same
    // exclusions as the in-process single-open mode. A missing/unreadable mapping simply
    // means "nothing disabled", which never blocks a launch.
    let blacklist = [];
    try {
      const mapping = readMapping(defaultMappingPath());
      if (!mapping.error) blacklist = mapping.workspaces.get(pathKey(args.workspacePath)) ?? [];
    } catch { /* best effort */ }
    const prepared = await orchestrator.prepare(args.workspacePath, {
      ...(args.name ? { name: args.name } : {}),
      shareData: args.shareData === true,
      blacklist,
    });
    const instance = orchestrator.launch(prepared);
    try {
      const url = await orchestrator.awaitReady(instance, { timeoutMs: args.timeoutMs ?? 90_000 });
      const port = instance.registryRecord?.port ?? null;
      // The instance must outlive this call: release the stdio pipes and the child
      // handle, otherwise they keep the *host* event loop alive and DSH never exits.
      detachInstance(instance);
      return {
        url,
        profileName: prepared.profileName,
        pid: instance.pid,
        workspacePath: prepared.workspacePath,
        port: typeof port === 'number' ? port : null,
        shareData: prepared.shareData === true,
      };
    } catch (error) {
      // Never leave a half-started instance behind because the URL never arrived.
      try { await orchestrator.stop(instance); } catch { /* best effort */ }
      throw error;
    }
  },
};

const LIST_TOOL = {
  name: 'list_workspace_instances',
  description:
    'List the DSH instances this manager launched for workspaces: profile, pid, workspace, URL, port, '
    + 'plus a liveness check on the process and the listening port.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        live: { type: 'number' },
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              profileName: NULLABLE_STRING,
              pid: { oneOf: [{ type: 'null' }, { type: 'number' }] },
              workspacePath: NULLABLE_STRING,
              url: NULLABLE_STRING,
              port: { oneOf: [{ type: 'null' }, { type: 'number' }] },
              alive: { type: 'boolean' },
              portReachable: { oneOf: [{ type: 'null' }, { type: 'boolean' }] },
            },
          },
        },
      },
    },
    render: (_args, value) => {
      const lines = [`Managed instances: ${value?.count ?? 0} registered, ${value?.live ?? 0} alive`];
      for (const row of value?.instances ?? []) {
        lines.push(`  ${row.alive ? '[up]  ' : '[dead]'} ${row.profileName}  pid=${row.pid}  port=${row.port ?? '?'}  ${row.url ?? '(no url)'}`);
        lines.push(`         workspace: ${row.workspacePath ?? '(unknown)'}${row.portReachable === false ? '  (port unreachable)' : ''}`);
      }
      if (!value?.instances?.length) lines.push('  (none)');
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute() {
    const { Orchestrator } = await import('../orchestrator-core/index.mjs');
    const orchestrator = new Orchestrator();
    const listed = await orchestrator.list({ probe: true });
    return {
      count: listed.count,
      live: listed.live,
      instances: listed.instances.map((row) => ({
        profileName: row.profileName ?? null,
        pid: typeof row.pid === 'number' ? row.pid : null,
        workspacePath: row.workspacePath ?? null,
        url: row.url ?? null,
        port: typeof row.port === 'number' ? row.port : null,
        alive: row.alive === true,
        portReachable: typeof row.portReachable === 'boolean' ? row.portReachable : null,
      })),
    };
  },
};

const STOP_TOOL = {
  name: 'stop_workspace_instance',
  description:
    'Stop a managed workspace instance. Identify it by pid, by profile name, or by workspace path. '
    + 'Terminates gracefully, force-kills the process tree if it lingers, and removes it from the registry.',
  parameters: {
    type: 'object',
    properties: {
      target: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Profile name, workspace path, or pid.' },
      pid: { oneOf: [{ type: 'null' }, { type: 'number' }], description: 'Convenience alternative to target.' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        id: NULLABLE_STRING,
        pid: { oneOf: [{ type: 'null' }, { type: 'number' }] },
        forced: { type: 'boolean' },
        dead: { type: 'boolean' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: `Stopped ${value?.id ?? '(unknown)'} (pid ${value?.pid ?? '?'}) — dead=${value?.dead}, forced=${value?.forced}`,
    }],
  },
  async execute(args = {}) {
    const target = args.pid ?? args.target;
    if (target === undefined || target === null) {
      throw new Error('stop_workspace_instance needs a `target` (profile name, workspace path, or pid) or `pid`.');
    }
    const { Orchestrator } = await import('../orchestrator-core/index.mjs');
    const orchestrator = new Orchestrator();
    const info = await orchestrator.stop(target);
    return {
      id: info.id ?? null,
      pid: typeof info.pid === 'number' ? info.pid : null,
      forced: info.forced === true,
      dead: info.dead === true,
    };
  },
};

/**
 * Snapshot used by `scan_plugins` to say whether isolated instances already exist.
 * Never throws: scanning plugins must not fail because instance state is unreadable.
 */
export async function instanceSummary() {
  try {
    const { Orchestrator } = await import('../orchestrator-core/index.mjs');
    const listed = await new Orchestrator().list({ probe: false });
    const live = listed.instances.filter((row) => row.alive);
    return {
      count: listed.count,
      live: listed.live,
      profiles: live.map((row) => row.profileName).filter(Boolean),
      error: null,
    };
  } catch (error) {
    return { count: 0, live: 0, profiles: [], error: error?.message ?? String(error) };
  }
}

export function buildLaunchTool() { return LAUNCH_TOOL; }
export function buildListTool() { return LIST_TOOL; }
export function buildStopTool() { return STOP_TOOL; }
export const INSTANCE_TOOLS = [LAUNCH_TOOL, LIST_TOOL, STOP_TOOL];
