// Veřejné API budoucího npm packagu. Entry skripty (a později dbu-txs) importují JEN odsud.
// Engine je topology-agnostický: všechny funkce berou Topology / ctx parametrem.
export type {
  Topology,
  WorkerDescriptor,
  ServiceBinding,
  ExternalServiceBinding,
  D1Binding,
  KvBinding,
  R2Binding,
  QueueProducer,
  QueueConsumer,
  SecretStoreBinding,
  DurableObjectBinding,
  WorkflowBinding,
  BuildSpec,
  EnvConfig,
  DeployEnv,
} from './types'

export { provision, deployOne, migrateOne, prefixFor, parsePrefix, entrypointInfo } from './engine'
export { parsePr } from './prefix'
export { resolveEnv, resolveDomain, nameFor, type EnvSelector } from './env'
export { cleanupEnv, type CleanupResult, type CleanupCtx } from './cleanup'
export { gc, type GcOpts, type GcResult } from './gc'
export { renderConfig, type RenderOpts } from './render-config'
export { lintTopology } from './lint'
export { consoleLogger, type Logger, type Ids, type CfCtx } from './cf-client'
