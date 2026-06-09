// Garbage-collect osiřelých preview prefixů. Čistá logika: enumerace pr-<N>-* napříč typy +
// určení osiřelých (PR co NENÍ otevřený) + cleanup. Seznam otevřených PR dodá volající (gh).
// POZN.: otevřený PR už NIKDY není orphan (žádný TTL/auto-teardown) — to byl explicit feedback.
import type { Topology } from './types'
import { cleanupPrefix } from './cleanup'
import { prefixFor, parsePrefix } from './prefix'
import {
  workersList,
  d1List,
  kvList,
  queueNames,
  r2Names,
  consoleLogger,
  type CfCtx,
  type Logger,
} from './cf-client'

export type GcOpts = { apply: boolean; log?: Logger }
export type GcResult = {
  prefixes: number
  open: number
  orphans: number[]
  failures: Record<number, string[]> // pr → labely nesmazaných zdrojů
}

// Posbírá PR čísla ze VŠECH existujících `pr-<N>-*` zdrojů (napříč typy).
async function enumeratePrNumbers(ctx: CfCtx): Promise<Set<number>> {
  const names = [
    ...(await workersList(ctx)),
    ...(await d1List()).map((d) => d.name),
    ...(await kvList()).map((n) => n.title),
    ...(await queueNames()),
    ...(await r2Names()),
  ]
  const prNums = new Set<number>()
  for (const n of names) {
    const pr = parsePrefix(n)
    if (pr !== null) prNums.add(pr)
  }
  return prNums
}

export async function gc(
  topology: Topology,
  openPrNumbers: number[],
  ctx: CfCtx,
  opts: GcOpts,
): Promise<GcResult> {
  const log = opts.log ?? consoleLogger
  const prNums = await enumeratePrNumbers(ctx)
  const open = new Set(openPrNumbers)

  // Orphan = existující prefix bez odpovídajícího OTEVŘENÉHO PR (zavřený / smazaná branch / závod).
  const orphans = [...prNums].filter((pr) => !open.has(pr))

  const failures: Record<number, string[]> = {}
  for (const pr of orphans) {
    const r = await cleanupPrefix(prefixFor(pr), topology, { ...ctx, dryRun: !opts.apply, log })
    if (r.failures.length) failures[pr] = r.failures
  }

  return { prefixes: prNums.size, open: openPrNumbers.length, orphans, failures }
}
