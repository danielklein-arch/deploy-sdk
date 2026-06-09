// Orchestrace nad topologií — čisté funkce, topology + env + logger injektované. Bez process.env / GH.
// env (DeployEnv, z resolveEnv) řídí prefix/domény/vars/secrets → stejný engine pro preview i stable.
import { $ } from 'bun'
import type { Topology, WorkerDescriptor, DeployEnv } from './types'
import {
  ensureD1,
  ensureKv,
  ensureQueue,
  ensureR2,
  applyD1Migrations,
  hasSqlMigrations,
  deployWorker,
  consoleLogger,
  type Logger,
  type Ids,
} from './cf-client'
import { computeVars, renderConfig } from './render-config'
import { resolveDomain } from './env'

export { prefixFor, parsePrefix } from './prefix'

// Vytvoří/reusne všechny sdílené zdroje pro env (idempotentní). Volat JEDNOU před deployem workerů.
export async function provision(
  topology: Topology,
  env: DeployEnv,
  log: Logger = consoleLogger,
): Promise<Ids> {
  const ids: Ids = { d1: {}, kv: {} }
  for (const r of topology.d1Resources) ids.d1[r] = await ensureD1(`${env.prefix}${r}`, log)
  for (const r of topology.kvResources) ids.kv[r] = await ensureKv(`${env.prefix}${r}`, log)
  for (const r of topology.queueResources) await ensureQueue(`${env.prefix}${r}`, log)
  for (const r of topology.r2Resources) await ensureR2(`${env.prefix}${r}`, log)
  // Shared buckety: preview kolabuje na `preview-${r}` (1 pro všechny PR), stable per-env. Persistují.
  for (const r of topology.sharedR2Resources ?? [])
    await ensureR2(`${env.ephemeral ? 'preview-' : env.prefix}${r}`, log)
  return ids
}

// Render configu → migrace D1 → deploy jednoho workeru. Vrací jeho URL.
export async function deployOne(
  w: WorkerDescriptor,
  topology: Topology,
  env: DeployEnv,
  opts: { ids: Ids; log?: Logger },
): Promise<string> {
  const { ids, log = consoleLogger } = opts
  // Build-before-deploy (Nuxt apod.) — spustí se z consumer root před renderem/deployem.
  // Resolved per-env vars injektujeme do build env → SPA zabakuje správné NUXT_PUBLIC_* per prostředí.
  if (w.build) {
    const buildEnv = computeVars(w, env, topology.previewZone)
    log.info(`[build] ${w.base}: ${w.build.command}`)
    await $`sh -c ${w.build.command}`.env({ ...process.env, ...buildEnv })
  }
  const cfg = await renderConfig(w, {
    env,
    ids,
    previewZone: topology.previewZone,
    secretsStoreId: topology.secretsStoreId,
    compat: topology.compat,
    sharedR2Resources: topology.sharedR2Resources,
  })
  // D1 migrace jen když worker má `migrations/` s .sql — jinak skip (wrangler by jinak tvrdě padl).
  if (w.d1?.length) {
    if (hasSqlMigrations(w.dir)) {
      for (const d of w.d1) await applyD1Migrations(`${env.prefix}${d.resource}`, cfg)
    } else {
      log.info(`[d1] ${w.base} nemá migrations/ → skip migrate`)
    }
  }
  const url = await deployWorker(cfg, { log })
  log.info(`[deploy] ${env.prefix}${w.base} → ${url}`)
  return url
}

// Veřejný entrypoint workeru: base + URL když má custom doménu (env-aware), jinak null
// (volající ji vezme z deploy artifactu workers.dev).
export function entrypointInfo(topology: Topology, env: DeployEnv): { base: string; url: string | null } {
  const w = topology.workers.find((x) => x.base === topology.entrypoint)
  if (!w) throw new Error(`entrypoint worker '${topology.entrypoint}' není v topology.workers`)
  return {
    base: w.base,
    url: w.customDomain ? `https://${resolveDomain(env, w.base, topology.previewZone)}` : null,
  }
}
