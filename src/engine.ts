// Orchestrace nad topologií — čisté funkce, topology + env + logger injektované. Bez process.env / GH.
// env (DeployEnv, z resolveEnv) řídí jména/domény/vars/secrets → stejný engine pro preview i stable.
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
import { nameFor, resolveDomain } from './env'

export { prefixFor, parsePrefix } from './prefix'

// Vytvoří/reusne všechny sdílené zdroje pro env (idempotentní). Volat JEDNOU před deployem workerů.
export async function provision(
  topology: Topology,
  env: DeployEnv,
  log: Logger = consoleLogger,
): Promise<Ids> {
  const ids: Ids = { d1: {}, kv: {} }
  for (const r of topology.d1Resources) ids.d1[r] = await ensureD1(nameFor(env, r), log)
  for (const r of topology.kvResources) ids.kv[r] = await ensureKv(nameFor(env, r), log)
  for (const r of topology.queueResources) await ensureQueue(nameFor(env, r), log)
  for (const r of topology.r2Resources) await ensureR2(nameFor(env, r), log)
  // Shared buckety: preview kolabuje na `preview-${r}` (1 pro všechny PR), stable per-env. Persistují.
  for (const r of topology.sharedR2Resources ?? [])
    await ensureR2(env.ephemeral ? `preview-${r}` : nameFor(env, r), log)
  return ids
}

// D1 migrace jednoho workeru. Custom `migrateCommand` (drizzle-kit apod.) má přednost — dostane
// ENVIRONMENT + D1_ID_<BINDING>/D1_NAME_<BINDING>; jinak wrangler `d1 migrations apply` nad rendered configem.
// Samostatně volatelná pro explicitní pre-deploy migrate krok u stable envů; deployOne ji volá inline.
export async function migrateOne(
  w: WorkerDescriptor,
  topology: Topology,
  env: DeployEnv,
  opts: { ids: Ids; log?: Logger },
): Promise<void> {
  const { ids, log = consoleLogger } = opts
  if (!w.d1?.length) return
  if (w.migrateCommand) {
    const migrateEnv: Record<string, string> = { ENVIRONMENT: env.key }
    for (const d of w.d1) {
      migrateEnv[`D1_ID_${d.binding}`] = ids.d1[d.resource] ?? ''
      migrateEnv[`D1_NAME_${d.binding}`] = nameFor(env, d.resource)
    }
    log.info(`[migrate] ${w.base}: ${w.migrateCommand}`)
    await $`sh -c ${w.migrateCommand}`.env({ ...process.env, ...migrateEnv })
    return
  }
  // wrangler cesta: jen když worker má `migrations/` s .sql — jinak skip (wrangler by jinak tvrdě padl)
  if (!hasSqlMigrations(w.dir)) {
    log.info(`[d1] ${w.base} nemá migrations/ → skip migrate`)
    return
  }
  const cfg = await renderConfig(w, { env, ids, topology })
  for (const d of w.d1) await applyD1Migrations(nameFor(env, d.resource), cfg)
}

// Render configu → migrace D1 → deploy jednoho workeru. Vrací jeho URL.
// skipMigrations: stable pipeline migruje explicitním krokem před deployem → tady přeskočit.
export async function deployOne(
  w: WorkerDescriptor,
  topology: Topology,
  env: DeployEnv,
  opts: { ids: Ids; log?: Logger; skipMigrations?: boolean },
): Promise<string> {
  const { ids, log = consoleLogger, skipMigrations = false } = opts
  // Build-before-deploy (Nuxt apod.) — spustí se z consumer root před renderem/deployem.
  // Resolved per-env vars injektujeme do build env → SPA zabakuje správné NUXT_PUBLIC_* per prostředí.
  if (w.build) {
    const buildEnv = computeVars(w, env, topology)
    log.info(`[build] ${w.base}: ${w.build.command}`)
    await $`sh -c ${w.build.command}`.env({ ...process.env, ...buildEnv })
  }
  const cfg = await renderConfig(w, { env, ids, topology })
  if (!skipMigrations) await migrateOne(w, topology, env, { ids, log })
  // workersDev=false → wrangler nevypíše workers.dev URL; URL pak = custom doména (nebo prázdno).
  const url = await deployWorker(cfg, { log, requireUrl: env.workersDev })
  const finalUrl = url || (w.customDomain ? `https://${resolveDomain(env, w.base, topology)}` : '')
  log.info(`[deploy] ${nameFor(env, w.base)} → ${finalUrl || '(bez veřejné URL)'}`)
  return finalUrl
}

// Veřejný entrypoint workeru: base + URL když má custom doménu (env-aware), jinak null
// (volající ji vezme z deploy artifactu workers.dev).
export function entrypointInfo(topology: Topology, env: DeployEnv): { base: string; url: string | null } {
  const w = topology.workers.find((x) => x.base === topology.entrypoint)
  if (!w) throw new Error(`entrypoint worker '${topology.entrypoint}' není v topology.workers`)
  return {
    base: w.base,
    url: w.customDomain ? `https://${resolveDomain(env, w.base, topology)}` : null,
  }
}
