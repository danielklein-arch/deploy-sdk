# @danielklein-arch/deploy-sdk

Wrangler-only **Cloudflare Workers deploy engine** — orchestruje per-PR ephemeral previews
**i** stálá prostředí (dev/staging/prod) čistě přes `wrangler` (žádná Alchemy/Terraform).

**Bun-only**: engine používá `$` z `bun` (každý wrangler call) + `Bun.write`/`Bun.file`.

## Koncept

Konzument dodá **`Topology`** (deklarace workerů + sdílených zdrojů + prostředí) a tenké entry
skripty / GitHub workflowy. Engine je topology-agnostický — funkce berou `Topology` + `DeployEnv`
parametrem, žádný `process.env` uvnitř.

- **Prostředí** = `resolveEnv(topology, { preview: N })` (ephemeral `pr-<N>-`) nebo
  `{ stable: 'dev' }` (persistent `dev-`/`staging-`/`prod-`). Per-env prefix / vars / domény
  (prod apex) / secrets.
- **Per-PR preview**: provision sdílených zdrojů → deploy workerů (matrix) → teardown na zavření PR.
- **Stálé prostředí**: push do dev/staging/prod větve → deploy, persistuje (žádný teardown).

## Veřejné API

```ts
import {
  resolveEnv, provision, deployOne, entrypointInfo,
  cleanupPrefix, gc, prefixFor, parsePrefix,
  type Topology, type DeployEnv, type WorkerDescriptor,
} from '@danielklein-arch/deploy-sdk'

const env = resolveEnv(topology, { preview: prNumber })      // nebo { stable: 'dev' }
const ids = await provision(topology, env)                    // ensure sdílených zdrojů (idempotentní)
const url = await deployOne(worker, topology, env, { ids })   // render + migrace + deploy 1 workeru
await cleanupPrefix(env.prefix, topology, { accountId, apiToken })  // teardown (preview)
await gc(topology, openPrNumbers, ctx, { apply })             // orphan cleanup zavřených PR
```

## Stav

`0.0.0` — extrahováno z `dbu-txs-preview-lab` (referenční consumer: lab + `examples/minimal-app`).
TODO před `1.0`: CLI bin (`npx deploy-sdk provision|deploy|gc`), npm publish, scope.

## Build

```bash
bun install
bun run build      # bun build → dist/index.js + tsc → dist/*.d.ts
```
