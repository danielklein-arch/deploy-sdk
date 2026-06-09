// Smaže VŠECHNY zdroje pro daný prefix `pr-<N>-`. Sdílí close-cleanup (cleanup-preview.ts)
// i GC (gc-previews.ts). Best-effort + retry (CF mazání je eventually-consistent).
// Vrací seznam selhání → caller failne job (hlučný cleanup, žádné tiché leaky).
import type { Topology } from './types'
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

export type CleanupResult = { prefix: string; failures: string[] }
export type CleanupCtx = CfCtx & { log?: Logger; dryRun?: boolean }

export async function cleanupPrefix(
  prefix: string,
  topology: Topology,
  ctx: CleanupCtx,
): Promise<CleanupResult> {
  const log = ctx.log ?? consoleLogger
  const failures: string[] = []
  const { workers, d1Resources, kvResources, queueResources, r2Resources } = topology

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
      await tryRun(`detach consumer ${prefix}${w.base} ← ${prefix}${c.resource}`, () =>
        removeQueueConsumer(`${prefix}${c.resource}`, `${prefix}${w.base}`),
      )

  for (const w of workers)
    await tryRun(`worker ${prefix}${w.base}`, () => deleteWorker(`${prefix}${w.base}`))

  // Workflows mají cloud-side identitu → mažou se zvlášť (worker delete je nesmaže).
  for (const w of workers)
    for (const wf of w.workflows ?? [])
      await tryRun(`workflow ${prefix}${wf.name}`, () => deleteWorkflow(`${prefix}${wf.name}`))

  for (const r of queueResources)
    await tryRun(`queue ${prefix}${r}`, () => deleteQueue(`${prefix}${r}`))

  // R2 — bucket nejde smazat neprázdný → nejdřív objekty (list přes CF API), pak bucket.
  // POZN.: jen per-PR `r2Resources`. `sharedR2Resources` se ZÁMĚRNĚ neteardownují (persistují přes PR).
  for (const r of r2Resources) {
    const bucket = `${prefix}${r}`
    await tryRun(`r2 ${bucket}`, async () => {
      for (const key of await r2ObjectKeys(bucket, ctx)) await deleteR2Object(bucket, key)
      await deleteR2Bucket(bucket)
    })
  }

  for (const r of d1Resources)
    await tryRun(`d1 ${prefix}${r}`, () => deleteD1(`${prefix}${r}`))

  // KV — mazání podle id, id z list match podle title.
  const kv = await kvList()
  for (const r of kvResources) {
    const title = `${prefix}${r}`
    const ns = kv.find((n) => n.title === title)
    if (!ns) {
      log.info(`[cleanup] – kv ${title} (not found)`)
      continue
    }
    await tryRun(`kv ${title}`, () => deleteKvById(ns.id))
  }

  return { prefix, failures }
}
