// Garbage-collect osiřelých preview envů. Čistá logika: enumerace per-PR zdrojů napříč typy
// (legacy `pr-<N>-*` / naming mode `<prefix>*-<N>`) + určení osiřelých (PR co NENÍ otevřený) + cleanup.
// Seznam otevřených PR dodá volající (gh).
// POZN.: otevřený PR už NIKDY není orphan (žádný TTL/auto-teardown) — to byl explicit feedback.
import type { Topology } from './types'
import { cleanupEnv } from './cleanup'
import { resolveEnv } from './env'
import { parsePr } from './prefix'
import {
  workersList,
  d1List,
  kvList,
  queueNames,
  r2Names,
  aiGatewayList,
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

// Posbírá PR čísla ze VŠECH existujících per-PR zdrojů (napříč typy).
async function enumeratePrNumbers(topology: Topology, ctx: CfCtx): Promise<Set<number>> {
  // AI Gateway list jen když je topologie používá — neforcovat 'AI Gateway Read' token scope na ostatní.
  const hasAig =
    (topology.aiGatewayResources?.length ?? 0) + (topology.sharedAiGatewayResources?.length ?? 0) > 0
  const names = [
    ...(await workersList(ctx)),
    ...(await d1List()).map((d) => d.name),
    ...(await kvList()).map((n) => n.title),
    ...(await queueNames()),
    ...(await r2Names()),
    ...(hasAig ? await aiGatewayList(ctx) : []),
  ]
  const prNums = new Set<number>()
  for (const n of names) {
    const pr = parsePr(n, topology)
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
  const prNums = await enumeratePrNumbers(topology, ctx)
  const open = new Set(openPrNumbers)

  // Orphan = existující prefix bez odpovídajícího OTEVŘENÉHO PR (zavřený / smazaná branch / závod).
  const orphans = [...prNums].filter((pr) => !open.has(pr))

  const failures: Record<number, string[]> = {}
  for (const pr of orphans) {
    const r = await cleanupEnv(resolveEnv(topology, { preview: pr }), topology, {
      ...ctx,
      dryRun: !opts.apply,
      log,
    })
    if (r.failures.length) failures[pr] = r.failures
  }

  return { prefixes: prNums.size, open: openPrNumbers.length, orphans, failures }
}
