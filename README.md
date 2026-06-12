# @danielklein/deploy-sdk

Wrangler-only **Cloudflare Workers deploy engine + CLI** — per-PR ephemeral previews **i** stálá
prostředí (dev/staging/production) čistě přes `wrangler` (žádná Alchemy/Terraform, žádný state store —
stav = naming konvence v CF účtu). Sourozenec [`@danielklein/ci-sdk`](https://www.npmjs.com/package/@danielklein/ci-sdk) (CI).

**Bun-only.** Konzument dodá jediný soubor **`topology.ts`** + vlastní `smoke.sh` + 3 tenké GH
workflowy (šablony v [`templates/`](templates/)). Všechno ostatní (provision/render/migrace/deploy/
cleanup/gc, multi-account, custom domény) řeší engine.

```
PR open  → provision → matrix deploy (každý worker paralelně) → smoke → sticky comment s URL
PR close → cleanup (smaže vše pr-<N>-*)
push dev/staging/prod → CI gate → provision → migrate → matrix deploy → smoke   (persistentní)
cron     → gc (smaže orphany zavřených PR)
```

---

## Adopce na novém projektu — krok za krokem

### 0. Předpoklady
- Bun monorepo (klidně single-worker), workery deploynutelné wranglerem (`main` = TS entry).
- GitHub repo s branch modelem `dev` (+ volitelně `staging`, `prod`). PR flow do `dev`.
- CF účet (nebo více — viz multi-account) a zóna pro custom domény (volitelné).
- CI doporučeně [`@danielklein/ci-sdk`](https://github.com/danielklein-arch/ci-sdk) (Nx affected checks) — není podmínka.

### 1. Instalace
```bash
bun add @danielklein/deploy-sdk wrangler
```

### 2. `topology.ts` v rootu repa
Jediný zdroj pravdy — deploy, migrace, cleanup i gc z něj čtou. Minimální single-worker projekt:

```ts
import type { Topology } from '@danielklein/deploy-sdk'

export const topology: Topology = {
  workers: [
    { base: 'app', dir: 'apps/app', main: 'src/index.ts', deployOrder: 0 },
  ],
  d1Resources: [],
  kvResources: [],
  queueResources: [],
  r2Resources: [],
  previewZone: 'example.com',          // zóna pro custom domény (nevyužije se bez customDomain)
  secretsStoreId: '<cf-secrets-store-id>', // jen pokud používáš secretsStore bindingy
  compat: { date: '2025-06-04', flags: ['nodejs_compat'] },
  entrypoint: 'app',                   // veřejný worker (cíl smoke + PR komentáře)
  environments: {
    dev: {},
    production: { branch: 'prod' },    // větev `prod` → env `production`
  },
}
```

Multi-worker s bindingy — každý worker deklaruje co používá, engine zajistí zdroje + per-env jména:

```ts
{
  base: 'order-service',
  dir: 'services/order',
  main: 'src/index.ts',
  services: [{ binding: 'SECRETS_STORE', target: 'secrets-store' }], // RPC na jiný worker topologie
  d1: [{ binding: 'ORDER_D1', resource: 'order' }],                  // resource = base name DB
  queueProducers: [{ binding: 'NOTIFICATIONS_QUEUE', resource: 'notifications' }],
  deployOrder: 0,
}
// … a zdroje zaregistruj v topology:
// d1Resources: ['order'], queueResources: ['notifications'], …
```

Kompletní referenční topologie (14 workerů, D1/KV/R2/queues/DO/workflows/crons/custom domény):
[`dbu-txs-preview-lab/topology.ts`](https://github.com/danielklein-arch/dbu-txs-preview-lab/blob/dev/topology.ts).

Validace: `bunx deploy-sdk lint` (advisory — env-reset pasti, duplicitní bindingy).

### 3. `scripts/smoke.sh` — tvůj health check
Workflow ho zavolá po deployi s env:

| Env var | Obsah |
|---|---|
| `ENTRYPOINT_URL` | URL entrypoint workeru (custom doména, jinak workers.dev) |
| `WORKER_URLS` | JSON `{ "<base>": "<url>", … }` všech workerů |
| `ENVIRONMENT_EXPECTED` | `preview` \| env key (`dev`/`production`…) |

Minimální verze: `curl -fsS "$ENTRYPOINT_URL/health"`. Vzor s retry/DO/workflows checky:
[lab `scripts/smoke.sh`](https://github.com/danielklein-arch/dbu-txs-preview-lab/blob/dev/scripts/smoke.sh).

### 4. Workflows — tenké wrappery nad reusable workflows
Orchestrace (provision → matrix deploy → smoke → cleanup/migrate) žije v reusable
workflows tohoto repa ([`.github/workflows/preview.yaml`](.github/workflows/preview.yaml),
[`.github/workflows/deploy-stable.yaml`](.github/workflows/deploy-stable.yaml)) — consumer má
jen trigger + `uses:` + parametry:
```bash
mkdir -p .github/workflows
cp node_modules/@danielklein/deploy-sdk/templates/{preview,deploy-stable,gc-previews}.yml .github/workflows/
```
- [`templates/preview.yml`](templates/preview.yml) — PR lifecycle wrapper (`uses: …/preview.yaml@v1`)
- [`templates/deploy-stable.yml`](templates/deploy-stable.yml) — stable wrapper (ci-sdk gate + `uses: …/deploy-stable.yaml@v1`)
- [`templates/gc-previews.yml`](templates/gc-previews.yml) — týdenní orphan GC (cron APPLY, manual dry-run)

Inputs reusable workflows: `env-passthrough` (CSV GH secrets → env pro topology vars),
`smoke-script` (default `scripts/smoke.sh`), `bun-version`, `skip-migrate` (stable, projekty bez D1).
Uprav: trigger `branches`, ci gate (`uses:` na tvůj CI).
CI doporučeně zvlášť v `ci.yml` jen na `pull_request` (push má gate v deploy-stable wrapperu → žádná duplicita).

### 5. GitHub secrets
```bash
# CF API token (dashboard → Create Token → custom). Account scopes:
#   Workers Scripts:Edit, D1:Edit, Queues:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit
# + pro custom domény: Zone:Read a Workers Routes:Edit na dané zóně
# + pro aiGatewayResources: AI Gateway:Read a AI Gateway:Edit
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID --body <account-id>
```

### 6. Branch protection
Na `dev` vyžaduj CI checks (ci.yml). Preview deploy NENÍ gate — rozbitý preview je levný; merge hlídá CI.

### 7. První PR
Otevři PR do `dev` → sticky komentář s preview URL všech workerů; zavři → vše se smaže.
Push do `dev` → stable deploy. Hotovo.

---

## Koncepty

### Prostředí & naming
- **Preview** = ephemeral, per-PR. **Stable** = persistentní (dev/staging/production), `STABLE_ENV` = jméno větve;
  liší-li se env key od větve, mapuje `EnvConfig.branch` (větev `prod` → env `production`).
- **Legacy prefix mode** (default): jména `pr-<N>-order` / `dev-order` / `production-order`.
- **Suffix naming mode** — pro adopci EXISTUJÍCÍCH zdrojů (dbu-txs vzor):
  ```ts
  naming: { prefix: 'dbu-txs-' },
  environments: {
    dev: {},                                            // dbu-txs-order-dev
    staging: {},                                        // dbu-txs-order-staging
    production: { branch: 'prod', suffix: '' },         // dbu-txs-order  (bare = živá data)
  }
  // preview: dbu-txs-order-<PR#>
  ```
  Provision je idempotentní (**adoptuje existující zdroje by-name** — nic nere-createuje), gc je
  suffix-aware (stable suffixy nikdy nematchne).

### Custom domény
- `customDomain: true` → default `<jméno-workeru>.<previewZone>`.
- Per-worker šablony (`{pr}` placeholder) + per-env:
  ```ts
  domainsByEnv: {
    preview: '{pr}.api.example.dev',
    dev: 'dev.api.example.dev',
    production: 'api.example.com',
  }
  ```
- `EnvConfig.domains` (env-level override) vyhrává nad šablonou.
- `injectUrlOf: { var: 'NUXT_PUBLIC_GATEWAY_URL', worker: 'gateway', path: '/api' }` — injektne URL
  jiného workeru jako var (bakeuje se i do SPA buildu); volitelný `path` suffix (`/feeds/seznam.xml`).

### Migrace D1
- **Default**: `wrangler d1 migrations apply` z `<dir>/migrations/*.sql` (skip když dir chybí).
- **Custom** (drizzle-kit aj.): `migrateCommand: 'cd services/x && bunx drizzle-kit migrate'` —
  dostane env `ENVIRONMENT` + `D1_ID_<BINDING>` / `D1_NAME_<BINDING>`. drizzle.config s d1-http
  driverem čte `D1_ID_…` + `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`. Vzor:
  [lab `services/drizzle-demo`](https://github.com/danielklein-arch/dbu-txs-preview-lab/tree/dev/services/drizzle-demo).
- **Pipeline**: preview migruje in-deploy (čerstvá DB); stable má explicitní `migrate` job PŘED deployem
  (fail = deploy nestartuje; vyžaduje additive/expand-contract migrace).

### Queues
```ts
queueConsumers: [
  { resource: 'audit-logs', batchSize: 100 },                                  // bez retries/DLQ
  { resource: 'queue-bus', maxRetries: 3 },                                    // retries bez DLQ
  { resource: 'notifications', batchSize: 1,
    deadLetter: { resource: 'notifications-dlq', maxRetries: 3 } },            // DLQ
]
```
Defaulty `batchSize=10`, `batchTimeout=5`.

### Multi-account + secrets
```ts
environments: {
  dev:        { accountId: '<dev-acct>',  apiTokenEnv: 'CLOUDFLARE_API_TOKEN_DEV',  secretsStoreId: '<dev-store>' },
  production: { accountId: '<prod-acct>', apiTokenEnv: 'CLOUDFLARE_API_TOKEN_PROD', secretsStoreId: '<prod-store>' },
}
```
CLI aktivuje správný account+token per env. `secretsStore` bindingy (CF Secrets Store) mají per-env
store id i per-env override jmen secretů (`EnvConfig.secrets`).

Per-PR secrets store NEJDE — CF dovoluje 1 store per account (open beta) a hodnoty jsou write-only
(žádný clone). Preview PRs sdílí store; per-env izolaci řeš přes `EnvConfig.secrets` override jmen.

### AI Gateway
```ts
aiGatewayResources: ['ai'],            // per-PR (pr-7-ai), teardown na PR close
sharedAiGatewayResources: ['ai-pool'], // preview kolabuje na preview-ai-pool, stable per-env; persistuje
workers: [{
  ...,
  ai: { binding: 'AI' },                                   // wrangler `ai` binding (max 1/worker)
  aiGateways: [{ binding: 'AI_GATEWAY_ID', resource: 'ai' }],
}]
```
AI Gateway **nemá** wrangler config binding — worker gateway referencuje za runtime podle id. SDK
gateway provisionuje přes CF REST API (wrangler příkaz neexistuje) a resolved jméno injektne jako
**var** (`binding` = jméno varu; bakeuje se i do SPA buildu):
```ts
// Workers AI přes gateway:
await env.AI.run('@cf/meta/llama-3.3-70b-instruct', input, { gateway: { id: env.AI_GATEWAY_ID } })
// HTTP provider (OpenAI/Anthropic/…):
fetch(`https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/${env.AI_GATEWAY_ID}/<provider>/...`)
```
Defaulty create: cache off, logy on, rate limiting off. Gateway id povoluje jen `[a-z0-9-]`, max
64 znaků vč. prefixu/suffixu (hlídá lint). CF limit 10 (free) / 20 (paid) gateways per account —
pozor u per-PR gateways na počet otevřených PR.

### Crons
- `crons: ['0 */6 * * *']` — všechny envs.
- `cronsByEnv: { dev: ['0 */6 * * *'], production: ['0 */6 * * *'] }` — per env (klíč = env key);
  **chybějící klíč = žádné crony** (renderuje explicitní `[]` → wrangler smaže stale triggery).
  Typicky: preview bez cronů (PR nemá spouštět produkční joby). Když je `cronsByEnv` definované,
  `crons` se ignoruje celé (hlídá lint).

### Další pole
`workflows` (+ `limits.steps`), `durableObjects` (SQLite), `vars`/`varsByEnv` (per-worker
per-env override — řeší env-reset past), `externalServices` (worker mimo topologii, literální jméno
per env), `vpcServices` (per-env `service_id`), `build` (build-before-deploy: Nuxt → `main`+`assets`),
`versionMetadata`, `sharedR2Resources` (bez teardownu, preview kolabuje na 1),
`browser: { binding }` (Browser Rendering — account-level, bez provisioningu),
`observability` (topology-level; per-worker `WorkerDescriptor.observability` ho NAHRAZUJE),
`EnvConfig.workersDev: false` (stable bez workers.dev).

---

## CLI

```bash
bunx deploy-sdk provision      # ensure zdrojů → emit ids/matrix/entrypoint(Url) do $GITHUB_OUTPUT
bunx deploy-sdk deploy <w>     # 1 worker (WORKER env); PREVIEW_IDS required; SKIP_MIGRATIONS=1 přeskočí migrace
bunx deploy-sdk migrate        # explicitní seriální D1 migrace všech workerů (stable krok)
bunx deploy-sdk cleanup        # teardown env (preview close) — exit 1 při failures
bunx deploy-sdk gc --open-prs 1,2,3 [--apply]   # orphan cleanup (default dry-run)
bunx deploy-sdk deploy-all     # lokální: provision + seriový deploy všeho
bunx deploy-sdk lint           # advisory kontrola topologie
```
Env: `PR_NUMBER` (preview) | `STABLE_ENV` (stable), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`-t/--topology` (default `./topology.ts`). Lokálně token fallne na wrangler OAuth.

## Veřejné API (lib)

```ts
import {
  resolveEnv, provision, deployOne, migrateOne, entrypointInfo,
  cleanupEnv, gc, nameFor, parsePr,
  type Topology, type DeployEnv, type WorkerDescriptor,
} from '@danielklein/deploy-sdk'
```

## Stav

`0.8.0` — referenční consumer: [`dbu-txs-preview-lab`](https://github.com/danielklein-arch/dbu-txs-preview-lab)
(14 workerů, plný dbu-txs clone) + `examples/minimal-app` (single worker).
- 0.8.0: `browser` binding (Browser Rendering), `cronsByEnv` (per-env cron gating), per-worker
  `observability` override, `injectUrlOf.path`.
- 0.7.0: AI Gateway (per-PR + shared, REST provisioning), `ai` binding, gateway var injection.
- 0.6.x: suffix naming mode, domain šablony (`{pr}`), queue consumer config, `migrateCommand`
  (drizzle), `vpcServices`, workflow `limits`, `observability`, `version_metadata`, `workersDev`,
  workflow šablony v `templates/`.
- 0.5.0: branch→env mapping, per-env `secretsStoreId`, `migrate` příkaz.
- 0.4.0: per-env CF account/token. 0.3.x: build hook + assets. 0.2.x: varsByEnv/sharedR2/external/lint.

## Build

```bash
bun install && bun run build   # bun build → dist + tsc → d.ts
```
