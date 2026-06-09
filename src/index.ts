// Veřejné API budoucího npm packagu. Entry skripty (a později dbu-txs) importují JEN odsud.
// Engine je topology-agnostický: všechny funkce berou Topology / ctx parametrem.
export type {
  Topology,
  WorkerDescriptor,
  ServiceBinding,
  D1Binding,
  KvBinding,
  R2Binding,
  QueueProducer,
  QueueConsumer,
  SecretStoreBinding,
  DurableObjectBinding,
  WorkflowBinding,
  EnvConfig,
  DeployEnv,
} from './types'

export { provision, deployOne, prefixFor, parsePrefix, entrypointInfo } from './engine'
export { resolveEnv, resolveDomain, type EnvSelector } from './env'
export { cleanupPrefix, type CleanupResult, type CleanupCtx } from './cleanup'
export { gc, type GcOpts, type GcResult } from './gc'
export { renderConfig, type RenderOpts } from './render-config'
export { consoleLogger, type Logger, type Ids, type CfCtx } from './cf-client'
