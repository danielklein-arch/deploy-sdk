# @danielklein/deploy-sdk

Wrangler-only **Cloudflare Workers deploy engine** — orchestruje per-PR ephemeral previews
**i** stálá prostředí (dev/staging/prod) čistě přes `wrangler` (žádná Alchemy/Terraform).

**Bun-only**: engine používá `$` z `bun` (každý wrangler call) + `Bun.write`/`Bun.file`.

## Koncept

Konzument dodá **`Topology`** (deklarace workerů + sdílených zdrojů + prostředí) a tenké entry
skripty / GitHub workflowy. Engine je topology-agnostický — funkce berou `Topology` + `DeployEnv`
parametrem, žádný `process.env` uvnitř.

- **Prostředí** = `resolveEnv(topology, { preview: N })` (ephemeral `pr-<N>-`) nebo
  `{ stable: 'dev' }` (persistent `dev-`/`staging-`/`production-`). Per-env prefix / vars / domény
  (prod apex) / secrets / `accountId`+`apiTokenEnv` (multi-account) / `secretsStoreId` (per-account store).
- **Branch→env mapping**: `EnvConfig.branch` — větev `prod` mapuje na env `production`
  (`resolveEnv` zkusí přímý klíč, pak scan podle `branch`). Prefix/ENVIRONMENT = env key.
- **Per-PR preview**: provision sdílených zdrojů → deploy workerů (matrix, migrace in-deploy) →
  teardown na zavření PR.
- **Stálé prostředí**: push do dev/staging/prod větve → CLI `migrate` (explicitní seriální D1 migrace)
  → deploy se `SKIP_MIGRATIONS=1`, persistuje (žádný teardown).

## Veřejné API

```ts
import {
  resolveEnv, provision, deployOne, migrateOne, entrypointInfo,
  cleanupPrefix, gc, prefixFor, parsePrefix,
  type Topology, type DeployEnv, type WorkerDescriptor,
} from '@danielklein/deploy-sdk'

const env = resolveEnv(topology, { preview: prNumber })      // nebo { stable: 'dev' }
const ids = await provision(topology, env)                    // ensure sdílených zdrojů (idempotentní)
const url = await deployOne(worker, topology, env, { ids })   // render + migrace + deploy 1 workeru
await cleanupPrefix(env.prefix, topology, { accountId, apiToken })  // teardown (preview)
await gc(topology, openPrNumbers, ctx, { apply })             // orphan cleanup zavřených PR
```

## CLI

`bunx deploy-sdk provision|deploy|migrate|cleanup|gc|deploy-all|lint` — env přes
`PR_NUMBER`/`STABLE_ENV` + `CLOUDFLARE_*`; `migrate` = explicitní pre-deploy D1 migrace
(stable envy), `deploy` s `SKIP_MIGRATIONS=1` je přeskočí.

## Stav

`0.6.0` — extrahováno z `dbu-txs-preview-lab` (referenční consumer: lab + `examples/minimal-app`).
- 0.6.0 (dbu-txs migration readiness): **suffix naming mode** (`topology.naming.prefix` → jména
  `dbu-txs-order-1577`/`-dev`/`-staging`/bare production; `EnvConfig.suffix`, suffix-aware `parsePr`/gc),
  **domain šablony** (`WorkerDescriptor.domainsByEnv`, `{pr}` placeholder), **queue consumer config**
  (batchSize/batchTimeout/maxRetries i bez DLQ), **`migrateCommand`** (drizzle-kit aj.; env dostane
  ENVIRONMENT + `D1_ID_<BINDING>`/`D1_NAME_<BINDING>`), **`vpcServices`** (per-env service_id),
  workflow `limits`, `observability`, `version_metadata`, per-env `workersDev` toggle.
  `cleanupPrefix` → `cleanupEnv(env, …)`.
- 0.5.0: branch→env mapping, per-env `secretsStoreId`, `migrate` příkaz + `migrateOne`.

## Build

```bash
bun install
bun run build      # bun build → dist/index.js + tsc → dist/*.d.ts
```
