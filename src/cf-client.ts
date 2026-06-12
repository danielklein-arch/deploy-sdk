// Centralizované wrappery nad wrangler CLI (+ CF REST API).
// VEŠKERÉ křehké parsování CLI výstupu žije TADY → jediné místo k opravě při bumpu wrangleru.
// Každý parser asertuje očekávaný formát → změna výstupu spadne hlučně, ne tiše.
// Ověřeno proti wrangler 4.98.0 (přesný pin v package.json).
import { existsSync, readdirSync } from 'node:fs'
import { $ } from 'bun'

export type Logger = { info: (m: string) => void; warn: (m: string) => void }
export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
}

export type D1Db = { uuid: string; name: string }
export type KvNs = { id: string; title: string }
// Vyřešené ID zdrojů (z ensure*), předávané do renderConfig.
export type Ids = { d1: Record<string, string>; kv: Record<string, string> }

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[cf-client] ${msg}`)
}

// ── D1 (umí --json) ──────────────────────────────────────────────────────────

export async function d1List(): Promise<D1Db[]> {
  const parsed = JSON.parse(await $`bunx wrangler d1 list --json`.text())
  assert(Array.isArray(parsed), `d1 list: čekal pole, dostal ${typeof parsed}`)
  for (const d of parsed) assert(d?.uuid && d?.name, `d1 list: položka bez uuid/name: ${JSON.stringify(d)}`)
  return parsed
}

export async function ensureD1(name: string, log: Logger = consoleLogger): Promise<string> {
  const existing = (await d1List()).find((d) => d.name === name)
  if (existing) {
    log.info(`[d1] reuse ${name} (${existing.uuid})`)
    return existing.uuid
  }
  log.info(`[d1] create ${name}`)
  await $`bunx wrangler d1 create ${name}`
  const created = (await d1List()).find((d) => d.name === name)
  assert(created, `D1 ${name} nenalezena po create`)
  return created.uuid
}

// ── KV (list už vrací JSON, bez --json) ──────────────────────────────────────

export async function kvList(): Promise<KvNs[]> {
  const parsed = JSON.parse(await $`bunx wrangler kv namespace list`.text())
  assert(Array.isArray(parsed), `kv list: čekal pole, dostal ${typeof parsed}`)
  for (const n of parsed) assert(n?.id && n?.title, `kv list: položka bez id/title: ${JSON.stringify(n)}`)
  return parsed
}

export async function ensureKv(title: string, log: Logger = consoleLogger): Promise<string> {
  const existing = (await kvList()).find((n) => n.title === title)
  if (existing) {
    log.info(`[kv] reuse ${title} (${existing.id})`)
    return existing.id
  }
  log.info(`[kv] create ${title}`)
  await $`bunx wrangler kv namespace create ${title}`
  const created = (await kvList()).find((n) => n.title === title)
  assert(created, `KV ${title} nenalezena po create`)
  return created.id
}

// ── Queues (NEumí --json → parse tabulky) ────────────────────────────────────

export async function queueNames(): Promise<string[]> {
  const out = await $`bunx wrangler queues list`.text()
  const rows = out
    .split('\n')
    .map((l) => l.split('│').map((c) => c.trim()))
    .filter((cells) => cells.length >= 4)
  // Asertace formátu: musí existovat hlavičkový řádek se sloupcem `name` (jinak se změnil layout).
  const hasHeader = rows.some((cells) => cells.includes('name'))
  const nonEmpty = out.trim().length > 0 && !/no queues|you haven't created/i.test(out)
  assert(!nonEmpty || hasHeader, `queues list: nenalezen sloupec 'name' — změnil se formát?\n${out}`)
  return rows.filter((cells) => cells[2] && cells[2] !== 'name').map((cells) => cells[2]!)
}

export async function ensureQueue(name: string, log: Logger = consoleLogger): Promise<void> {
  if ((await queueNames()).includes(name)) {
    log.info(`[queue] reuse ${name}`)
    return
  }
  log.info(`[queue] create ${name}`)
  await $`bunx wrangler queues create ${name}`
}

// ── R2 (NEumí --json → parse `name: <bucket>` řádky) ─────────────────────────

export async function r2Names(): Promise<string[]> {
  const out = await $`bunx wrangler r2 bucket list`.text()
  const names = out
    .split('\n')
    .map((l) => l.match(/^name:\s+(\S+)/)?.[1])
    .filter((n): n is string => !!n)
  // Asertace: neprázdný výstup bez jediného `name:` řádku ⇒ změna formátu.
  const nonEmpty = out.trim().length > 0 && !/no buckets|you don't have/i.test(out)
  assert(!nonEmpty || names.length > 0, `r2 bucket list: nenalezen 'name:' řádek — změnil se formát?\n${out}`)
  return names
}

export async function ensureR2(name: string, log: Logger = consoleLogger): Promise<void> {
  if ((await r2Names()).includes(name)) {
    log.info(`[r2] reuse ${name}`)
    return
  }
  log.info(`[r2] create ${name}`)
  await $`bunx wrangler r2 bucket create ${name}`
}

// ── D1 migrace ───────────────────────────────────────────────────────────────

// True když `<dir>/migrations` existuje a má aspoň 1 `.sql`. Bez migrací wrangler `migrations apply`
// tvrdě padá ("No migrations present at <dir>") → v paralelním matrixu kaskáda 10143 na závislých
// workerech. Proto migrate krok přeskočíme, když není co aplikovat.
export function hasSqlMigrations(workerDir: string): boolean {
  const dir = `${workerDir}/migrations`
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.sql'))
}

export async function applyD1Migrations(dbName: string, configPath: string): Promise<void> {
  await $`bunx wrangler d1 migrations apply ${dbName} --remote -c ${configPath}`
}

// ── Deploy ───────────────────────────────────────────────────────────────────

// Retry na 10143 (service binding cíl ještě nenasazený) — plně paralelní matrix deployuje
// workery v nedeterministickém pořadí; cíl se doregistruje za pár sekund.
// requireUrl=false (workers_dev vypnutý) → úspěšný deploy bez workers.dev URL vrací ''.
export async function deployWorker(
  configPath: string,
  opts: { retries?: number; log?: Logger; requireUrl?: boolean } = {},
): Promise<string> {
  const { retries = 5, log = consoleLogger, requireUrl = true } = opts
  for (let attempt = 0; ; attempt++) {
    const res = await $`bunx wrangler deploy -c ${configPath}`.quiet().nothrow()
    const out = res.stdout.toString() + res.stderr.toString()
    const m = out.match(/https:\/\/[^\s]+\.workers\.dev/)
    if (res.exitCode === 0 && (m || !requireUrl)) return m?.[0] ?? ''
    // Jen kód 10143 (CF ho spolehlivě připne k „service binding target not found"). Generický
    // text „which was not found" by maskoval i permanentní chyby (překlep v názvu) → 50s zbytečných retry.
    const targetNotReady = /code: 10143/.test(out)
    if (targetNotReady && attempt < retries) {
      log.info(`[deploy] service binding cíl ještě není připraven, retry ${attempt + 1}/${retries} za 10s`)
      await new Promise((r) => setTimeout(r, 10_000))
      continue
    }
    assert(res.exitCode === 0 && (m || !requireUrl), `deploy selhal:\n${out}`)
    return m?.[0] ?? ''
  }
}

// ── CF REST API (věci co wrangler neumí: list scripts, list R2 objektů) ───────
// Pozn.: resolve tokenu (čte process.env / wrangler config) žije v entry-side scripts/cf-token.ts,
// ne tady — lib zůstává bez process.env (package purity). Token se předává přes CfCtx.

export type CfCtx = { accountId: string; apiToken: string }

async function cfApi<T>(
  ctx: CfCtx,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ success: boolean; result?: T; errors?: Array<{ code: number; message: string }>; status: number }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ctx.accountId}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${ctx.apiToken}`,
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  const j = (await res.json()) as { success: boolean; result?: T; errors?: Array<{ code: number; message: string }> }
  return { ...j, status: res.status }
}

// Všechny worker scripty v účtu (wrangler nemá list scripts) → names.
export async function workersList(ctx: CfCtx): Promise<string[]> {
  const j = await cfApi<Array<{ id: string }>>(ctx, '/workers/scripts')
  return j.success ? (j.result ?? []).map((s) => s.id) : []
}

export async function r2ObjectKeys(bucket: string, ctx: CfCtx): Promise<string[]> {
  const j = await cfApi<Array<{ key: string }>>(ctx, `/r2/buckets/${bucket}/objects`)
  return j.success ? (j.result ?? []).map((o) => o.key) : []
}

// ── AI Gateway (jen REST API — wrangler příkaz neexistuje) ───────────────────

// Create-body defaulty: cache vypnutá (ttl 0), logy zapnuté, rate limiting vypnutý (0/0).
// Všechna pole jsou v create API required. Exportováno kvůli testu.
export const aiGatewayCreateBody = (id: string) => ({
  id,
  cache_invalidate_on_update: true,
  cache_ttl: 0, // 0 = cache off
  collect_logs: true,
  rate_limiting_interval: 0, // 0 = rate limiting off
  rate_limiting_limit: 0,
})

export async function aiGatewayList(ctx: CfCtx): Promise<string[]> {
  const names: string[] = []
  for (let page = 1; ; page++) {
    const j = await cfApi<Array<{ id: string }>>(ctx, `/ai-gateway/gateways?page=${page}&per_page=50`)
    assert(j.success, `ai-gateway list selhal: ${JSON.stringify(j.errors)}`)
    const batch = (j.result ?? []).map((g) => g.id)
    names.push(...batch)
    if (batch.length < 50) return names
  }
}

export async function ensureAiGateway(name: string, ctx: CfCtx, log: Logger = consoleLogger): Promise<void> {
  if ((await aiGatewayList(ctx)).includes(name)) {
    log.info(`[ai-gateway] reuse ${name}`)
    return
  }
  log.info(`[ai-gateway] create ${name}`)
  const j = await cfApi(ctx, '/ai-gateway/gateways', { method: 'POST', body: aiGatewayCreateBody(name) })
  assert(j.success, `ai-gateway create ${name} selhal: ${JSON.stringify(j.errors)}`)
}

export async function deleteAiGateway(name: string, ctx: CfCtx): Promise<void> {
  const j = await cfApi(ctx, `/ai-gateway/gateways/${name}`, { method: 'DELETE' })
  if (j.success || j.status === 404) return // 404 = už neexistuje = success
  throw new Error(`[cf-client] ai-gateway delete ${name} selhal: ${JSON.stringify(j.errors)}`)
}

// ── Delete wrappery (best-effort orchestruje cleanup.ts) ─────────────────────

export const removeQueueConsumer = (queue: string, worker: string) =>
  $`bunx wrangler queues consumer remove ${queue} ${worker}`.quiet()
// `wrangler delete` umí workera smazat a PŘESTO vrátit exit 1 (post-delete chyba na route/doméně);
// následný retry pak narazí na 10090 „does not exist". Obojí = už smazaný → success (žádná false-failure).
export async function deleteWorker(name: string): Promise<void> {
  const res = await $`bunx wrangler delete --name ${name} --force`.quiet().nothrow()
  if (res.exitCode === 0) return
  const out = res.stdout.toString() + res.stderr.toString()
  if (/code: 10090|does not exist/.test(out)) return // worker už neexistuje = success
  throw new Error(`worker delete failed:\n${out}`)
}
export const deleteQueue = (name: string) => $`bunx wrangler queues delete ${name}`.quiet()
export const deleteR2Object = (bucket: string, key: string) =>
  $`bunx wrangler r2 object delete ${`${bucket}/${key}`} --remote`.quiet()
export const deleteR2Bucket = (name: string) => $`bunx wrangler r2 bucket delete ${name}`.quiet()
export const deleteD1 = (name: string) => $`bunx wrangler d1 delete ${name} -y`.quiet()
export const deleteKvById = (id: string) =>
  $`bunx wrangler kv namespace delete --namespace-id ${id}`.quiet()
// `< /dev/null` → non-TTY nepromptuje (jinak by CI cleanup mohl zamrznout na confirm).
export const deleteWorkflow = (name: string) => $`bunx wrangler workflows delete ${name} < /dev/null`.quiet()
