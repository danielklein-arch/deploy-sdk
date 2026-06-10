// Smaže VŠECHNY zdroje daného env (typicky preview `pr-<N>`). Sdílí close-cleanup i GC.
// Best-effort + retry (CF mazání je eventually-consistent).
// Vrací seznam selhání → caller failne job (hlučný cleanup, žádné tiché leaky).
import type { Topology, DeployEnv } from './types'
import { nameFor } from './env'
import {
  consoleLogger,
  kvList,
  r2ObjectKeys,
  removeQueueConsumer,
  deleteWorker,
  deleteWorkflow,
  deleteQueue,
  deleteR2Object,
  deleteR2Bucket,
  deleteD1,
  deleteKvById,
  type Logger,
  type CfCtx,
} from './cf-client'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type CleanupResult = { env: string; failures: string[] }
export type CleanupCtx = CfCtx & { log?: Logger; dryRun?: boolean }

export async function cleanupEnv(
  env: DeployEnv,
  topology: Topology,
  ctx: CleanupCtx,
): Promise<CleanupResult> {
  const log = ctx.log ?? consoleLogger
  const failures: string[] = []
  const { workers, d1Resources, kvResources, queueResources, r2Resources } = topology
  const name = (base: string): string => nameFor(env, base)

  async function tryRun(label: string, fn: () => Promise<unknown>, retries = 2) {
    if (ctx.dryRun) {
      log.info(`[cleanup:dry] would delete → ${label}`)
      return
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fn()
        log.info(`[cleanup] ✓ ${label}`)
        return
      } catch (e) {
        if (attempt >= retries) {
          log.warn(`[cleanup] ✗ ${label} (${String(e).split('\n')[0]})`)
          failures.push(label)
          return
        }
        await sleep(2000)
      }
    }
  }

  // Detach consumery NEJDŘÍV — jinak cyklická závislost queue↔consumer worker.
  for (const w of workers)
    for (const c of w.queueConsumers ?? [])
      await tryRun(`detach consumer ${name(w.base)} ← ${name(c.resource)}`, () =>
        removeQueueConsumer(name(c.resource), name(w.base)),
      )

  for (const w of workers) await tryRun(`worker ${name(w.base)}`, () => deleteWorker(name(w.base)))

  // Workflows mají cloud-side identitu → mažou se zvlášť (worker delete je nesmaže).
  for (const w of workers)
    for (const wf of w.workflows ?? [])
      await tryRun(`workflow ${name(wf.name)}`, () => deleteWorkflow(name(wf.name)))

  for (const r of queueResources) await tryRun(`queue ${name(r)}`, () => deleteQueue(name(r)))

  // R2 — bucket nejde smazat neprázdný → nejdřív objekty (list přes CF API), pak bucket.
  // POZN.: jen per-PR `r2Resources`. `sharedR2Resources` se ZÁMĚRNĚ neteardownují (persistují přes PR).
  for (const r of r2Resources) {
    const bucket = name(r)
    await tryRun(`r2 ${bucket}`, async () => {
      for (const key of await r2ObjectKeys(bucket, ctx)) await deleteR2Object(bucket, key)
      await deleteR2Bucket(bucket)
    })
  }

  for (const r of d1Resources) await tryRun(`d1 ${name(r)}`, () => deleteD1(name(r)))

  // KV — mazání podle id, id z list match podle title.
  const kv = await kvList()
  for (const r of kvResources) {
    const title = name(r)
    const ns = kv.find((n) => n.title === title)
    if (!ns) {
      log.info(`[cleanup] – kv ${title} (not found)`)
      continue
    }
    await tryRun(`kv ${title}`, () => deleteKvById(ns.id))
  }

  return { env: env.name, failures }
}
