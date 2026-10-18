// Public entry point for dsh-orchestrator-core.
export {
  Orchestrator, deriveProfileName, STORAGE_ROWS, parseComposedEntries, isThirdPartyRow,
} from './src/orchestrator.mjs'
export {
  resolveDshHome, resolveInstall, exeFromWindowsRegistry,
  orchestratorRoot, instanceDataRoot, profileDir, profilesRoot,
} from './src/paths.mjs'
export { spawnInstance, awaitReady, stop, waitExit, runCli, detachInstance } from './src/process.mjs'
export { Registry } from './src/registry.mjs'
export {
  parsePatchRows, thirdPartyRows, disablePlugins, backupFile,
} from './src/profile-patch.mjs'
export { isAlive, probePort, killTree, waitUntilDead } from './src/probe.mjs'
