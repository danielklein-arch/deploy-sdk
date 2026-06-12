#!/usr/bin/env bun
// CLI bin packagu (`bunx deploy-sdk <cmd>`). Samostatný entry — NE pure lib, smí číst env.
// Consolida­ce toho, co dříve dělaly per-consumer entry skripty (provision/deploy/cleanup/gc).
// Consumer dodá jen `topology.ts` + workflowy + smoke; CLI vlastní env→ctx wiring.
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import {
  resolveEnv,
  provision,
  deployOne,
  migrateOne,
  entrypointInfo,
  cleanupEnv,
  gc,
  lintTopology,
  type Topology,
  type DeployEnv,
  type Ids,
} from './index'
import { resolveCfToken } from './token'

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function usage(): never {
  fail(`deploy-sdk <command> [-t topology]

  provision              ensure sdílených zdrojů → emit ids/matrix/entrypoint/entrypointUrl/envKey
  deploy <worker>        deploy 1 workeru (PREVIEW_IDS env nebo --ids); zapíše .preview/url-<w>.txt
                         SKIP_MIGRATIONS=1 → přeskočí D1 migrace (stable: explicitní migrate krok)
  migrate                seriálně D1 migrace všech workerů s migrations/ (PREVIEW_IDS env nebo --ids)
  cleanup                teardown všech zdrojů pro prefix prostředí (exit 1 při failures)
  gc --open-prs <csv>    smaž osiřelé pr-*-* (zavřené PR); [--apply], jinak dry-run
  deploy-all             lokální: provision + sériový deploy všech workerů
  lint                   statická kontrola topologie (env-reset past) — advisory

Common: -t/--topology <path> (default $TOPOLOGY_PATH || ./topology.ts; resolve z cwd)
Env: PR_NUMBER (preview) | STABLE_ENV (stable), CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN`)
}

async function loadTopology(topoPath: string): Promise<Topology> {
  const mod = (await import(resolve(process.cwd(), topoPath))) as { topology?: Topology }
  if (!mod.topology) throw new Error(`modul '${topoPath}' neexportuje 'topology'`)
  return mod.topology
}

// Aktivuje per-env CF account + token do process.env → všechny wrangler shell cally i REST API
// míří na správný account (multi-account: dbu-txs dev≠prod). Fallback na ambient (single-account).
function activateAccount(env: DeployEnv): void {
  const accountId = env.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) fail(`env '${env.name}': chybí accountId (topology) ani CLOUDFLARE_ACCOUNT_ID`)
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId
  if (env.apiTokenEnv) {
    const token = process.env[env.apiTokenEnv]
    if (!token) fail(`env '${env.name}': chybí API token v env proměnné '${env.apiTokenEnv}'`)
    process.env.CLOUDFLARE_API_TOKEN = token
  }
}

function resolveDeployEnv(topology: Topology): DeployEnv {
  let env: DeployEnv
  if (process.env.STABLE_ENV) env = resolveEnv(topology, { stable: process.env.STABLE_ENV })
  else if (process.env.PR_NUMBER) env = resolveEnv(topology, { preview: Number(process.env.PR_NUMBER) })
  else throw new Error('PR_NUMBER (preview) nebo STABLE_ENV (stable) required')
  activateAccount(env) // per-env account/token → process.env (wrangler + API)
  return env
}

function emit(lines: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  else process.stdout.write(lines)
}

function requireAccount(): string {
  return process.env.CLOUDFLARE_ACCOUNT_ID ?? fail('CLOUDFLARE_ACCOUNT_ID env required')
}

function parseIds(): Ids {
  const raw = values.ids ?? process.env.PREVIEW_IDS ?? fail('PREVIEW_IDS env nebo --ids required')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('PREVIEW_IDS/--ids není validní JSON')
  }
}

// Advisory lint — vypíše varování (env-reset past), neblokuje.
function warnLint(topology: Topology): void {
  for (const w of lintTopology(topology)) console.warn(`[lint] ⚠ ${w}`)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    topology: { type: 'string', short: 't' },
    ids: { type: 'string' },
    'open-prs': { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
})
const cmd = positionals[0]
const topoPath = values.topology ?? process.env.TOPOLOGY_PATH ?? './topology.ts'

switch (cmd) {
  case 'lint': {
    const topology = await loadTopology(topoPath)
    const warnings = lintTopology(topology)
    for (const w of warnings) console.warn(`[lint] ⚠ ${w}`)
    console.log(warnings.length ? `[lint] ${warnings.length} varování` : '[lint] ✓ čisté')
    break
  }

  case 'provision': {
    const topology = await loadTopology(topoPath)
    warnLint(topology)
    const env = resolveDeployEnv(topology) // aktivuje per-env account/token
    const accountId = requireAccount()
    const ids = await provision(topology, env, { ctx: { accountId, apiToken: await resolveCfToken() } })
    const ep = entrypointInfo(topology, env)
    emit(
      `ids=${JSON.stringify(ids)}\n` +
        `matrix=${JSON.stringify(topology.workers.map((w) => w.base))}\n` +
        `entrypoint=${ep.base}\n` +
        `entrypointUrl=${ep.url ?? ''}\n` +
        `envKey=${env.key}\n`,
    )
    break
  }

  case 'deploy': {
    const base = positionals[1] ?? process.env.WORKER ?? fail('worker base required: deploy <worker>')
    const ids = parseIds()
    const topology = await loadTopology(topoPath)
    const env = resolveDeployEnv(topology)
    const w = topology.workers.find((x) => x.base === base)
    if (!w) throw new Error(`neznámý worker: ${base}`)
    const url = await deployOne(w, topology, env, { ids, skipMigrations: process.env.SKIP_MIGRATIONS === '1' })
    await Bun.write(`.preview/url-${base}.txt`, url)
    console.log(`URL=${url}`)
    break
  }

  // Explicitní pre-deploy migrace (stable envy): seriálně, fail = exit ≠ 0 → deploy se nespustí.
  case 'migrate': {
    const ids = parseIds()
    const topology = await loadTopology(topoPath)
    const env = resolveDeployEnv(topology)
    const ordered = [...topology.workers].sort((a, b) => a.deployOrder - b.deployOrder)
    for (const w of ordered) await migrateOne(w, topology, env, { ids })
    console.log(`[migrate] ✓ env ${env.name} hotovo`)
    break
  }

  case 'cleanup': {
    const topology = await loadTopology(topoPath)
    const env = resolveDeployEnv(topology) // aktivuje per-env account/token
    const accountId = requireAccount()
    const { failures } = await cleanupEnv(env, topology, { accountId, apiToken: await resolveCfToken() })
    if (failures.length) {
      console.error(`\n[cleanup] ✗ ${failures.length} zdrojů se nepodařilo smazat:`)
      for (const f of failures) console.error(`  - ${f}`)
      process.exit(1)
    }
    console.log('[cleanup] ✓ hotovo, vše smazáno')
    break
  }

  case 'gc': {
    const topology = await loadTopology(topoPath)
    activateAccount(resolveEnv(topology, { preview: 0 })) // gc maže preview orphany → preview account
    const accountId = requireAccount()
    const apply = values.apply || process.env.GC_APPLY === 'true'
    const openPrNumbers = (values['open-prs'] ?? process.env.OPEN_PRS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
    const res = await gc(topology, openPrNumbers, { accountId, apiToken: await resolveCfToken() }, { apply })
    console.log(`[gc] pr-* prefixů: ${res.prefixes}, otevřených PR: ${res.open}, osiřelých: ${res.orphans.length}`)
    if (!res.orphans.length) console.log('[gc] nic ke smazání')
    else {
      console.log(`[gc] osiřelé prefixy: ${res.orphans.map((n) => `pr-${n}-`).join(', ')}`)
      console.log(apply ? '[gc] APPLY — mažu' : '[gc] DRY-RUN — --apply pro reálné smazání')
    }
    for (const [pr, fs] of Object.entries(res.failures)) console.error(`[gc] ✗ pr-${pr}-: ${fs.length} selhání`)
    process.exit(Object.keys(res.failures).length ? 1 : 0)
  }

  case 'deploy-all': {
    const topology = await loadTopology(topoPath)
    warnLint(topology)
    const env = resolveDeployEnv(topology) // aktivuje per-env account/token
    console.log(`[deploy-all] env ${env.name} → prefix ${env.prefix}`)
    const accountId = requireAccount()
    const ids = await provision(topology, env, { ctx: { accountId, apiToken: await resolveCfToken() } })
    const ordered = [...topology.workers].sort((a, b) => a.deployOrder - b.deployOrder)
    const urls: Record<string, string> = {}
    for (const w of ordered) urls[w.base] = await deployOne(w, topology, env, { ids })
    const ep = entrypointInfo(topology, env)
    console.log(`ENTRYPOINT_URL=${ep.url ?? urls[ep.base]}`)
    break
  }

  default:
    usage()
}
