import { expect, test } from 'bun:test'
import { resolveEnv } from './env'
import { lintTopology } from './lint'
import { renderConfig } from './render-config'
import type { Topology, WorkerDescriptor } from './types'

const bank: WorkerDescriptor = {
  base: 'bank-service',
  dir: 'services/bank',
  main: 'src/index.ts',
  vars: { COMMON: 'x' },
  varsByEnv: {
    preview: { FINBRICKS_BASE_URI: 'https://api.sandbox.finbricks.com' },
    dev: { FINBRICKS_BASE_URI: 'https://api.sandbox.finbricks.com' },
    prod: { FINBRICKS_BASE_URI: 'https://api.finbricks.com' },
  },
  externalServices: [
    { binding: 'MDM_GATEWAY', namesByEnv: { preview: 'mdm-preview', dev: 'mdm-dev', prod: 'mdm-prod' } },
  ],
  r2: [
    { binding: 'DOCS', resource: 'documents' },
    { binding: 'RCPT', resource: 'receipts' },
  ],
  deployOrder: 0,
}

const topology: Topology = {
  workers: [bank],
  d1Resources: [],
  kvResources: [],
  queueResources: [],
  r2Resources: ['receipts'],
  sharedR2Resources: ['documents'],
  previewZone: 'kleindaniel.com',
  secretsStoreId: 'store-id',
  compat: { date: '2025-06-04', flags: ['nodejs_compat'] },
  entrypoint: 'bank-service',
  environments: {
    preview: { vars: { TIER: 'sandbox' } },
    prod: { prefix: 'prod-', vars: { TIER: 'prod' } },
  },
}

const opts = (env: ReturnType<typeof resolveEnv>, t: Topology = topology) => ({
  env,
  ids: { d1: {}, kv: {} },
  topology: t,
})

const read = (path: string) => Bun.file(path).json()

test('resolveEnv preview: key=preview, merguje environments.preview', () => {
  const env = resolveEnv(topology, { preview: 7 })
  expect(env.key).toBe('preview')
  expect(env.prefix).toBe('pr-7-')
  expect(env.ephemeral).toBe(true)
  expect(env.vars).toEqual({ ENVIRONMENT: 'preview', TIER: 'sandbox' })
})

test('resolveEnv stable: key=name, prefix override', () => {
  const env = resolveEnv(topology, { stable: 'prod' })
  expect(env.key).toBe('prod')
  expect(env.prefix).toBe('prod-')
  expect(env.vars.TIER).toBe('prod')
})

test('render preview: sandbox finbricks, external mdm-preview, shared bucket preview-, per-PR receipts', async () => {
  const env = resolveEnv(topology, { preview: 7 })
  const cfg = await read(await renderConfig(bank, opts(env)))
  expect(cfg.vars.FINBRICKS_BASE_URI).toBe('https://api.sandbox.finbricks.com')
  expect(cfg.vars.ENVIRONMENT).toBe('preview')
  expect(cfg.services).toContainEqual({ binding: 'MDM_GATEWAY', service: 'mdm-preview' })
  expect(cfg.r2_buckets).toContainEqual({ binding: 'DOCS', bucket_name: 'preview-documents' })
  expect(cfg.r2_buckets).toContainEqual({ binding: 'RCPT', bucket_name: 'pr-7-receipts' })
})

test('render prod: prod finbricks (NO reset), external mdm-prod, shared bucket prod-', async () => {
  const env = resolveEnv(topology, { stable: 'prod' })
  const cfg = await read(await renderConfig(bank, opts(env)))
  expect(cfg.vars.FINBRICKS_BASE_URI).toBe('https://api.finbricks.com')
  expect(cfg.services).toContainEqual({ binding: 'MDM_GATEWAY', service: 'mdm-prod' })
  expect(cfg.r2_buckets).toContainEqual({ binding: 'DOCS', bucket_name: 'prod-documents' })
  expect(cfg.r2_buckets).toContainEqual({ binding: 'RCPT', bucket_name: 'prod-receipts' })
})

test('render: chybějící external name pro env → throw', async () => {
  const env = resolveEnv(topology, { preview: 1 })
  const w: WorkerDescriptor = {
    base: 'x',
    dir: 'x',
    main: 'i.ts',
    externalServices: [{ binding: 'MDM', namesByEnv: { prod: 'mdm-prod' } }], // chybí 'preview'
    deployOrder: 0,
  }
  expect(renderConfig(w, opts(env))).rejects.toThrow("chybí jméno pro env 'preview'")
})

test('resolveEnv: neznámé stable env → throw', () => {
  expect(() => resolveEnv(topology, { stable: 'staging' })).toThrow('neznámé stálé prostředí')
})

test('resolveEnv: per-env accountId + apiTokenEnv (multi-account)', () => {
  const t: Topology = {
    ...topology,
    environments: {
      preview: { accountId: 'acc-dev', apiTokenEnv: 'TOK_DEV' },
      prod: { prefix: 'prod-', accountId: 'acc-prod', apiTokenEnv: 'TOK_PROD' },
    },
  }
  const prev = resolveEnv(t, { preview: 1 })
  expect(prev.accountId).toBe('acc-dev')
  expect(prev.apiTokenEnv).toBe('TOK_DEV')
  const prod = resolveEnv(t, { stable: 'prod' })
  expect(prod.accountId).toBe('acc-prod')
  expect(prod.apiTokenEnv).toBe('TOK_PROD')
  // backward compat: bez accountId → undefined (CLI fallne na ambient)
  expect(resolveEnv({ ...topology, environments: { dev: {} } }, { stable: 'dev' }).accountId).toBeUndefined()
})

test('render build worker: main = build output + assets binding', async () => {
  const fe: WorkerDescriptor = {
    base: 'frontend',
    dir: 'apps/frontend',
    main: 'src/index.ts',
    build: { command: 'bunx nx build frontend', main: '.output/server/index.mjs', assets: '.output/public' },
    deployOrder: 2,
  }
  const env = resolveEnv(topology, { preview: 3 })
  const cfg = await read(await renderConfig(fe, opts(env)))
  expect(cfg.main).toBe('../apps/frontend/.output/server/index.mjs')
  expect(cfg.assets).toEqual({ directory: '../apps/frontend/.output/public' })
})

// ── 0.6.0: suffix naming, domain šablony, queue config, vpc, limits, observability, version_metadata ──

const namedTopology: Topology = {
  ...topology,
  naming: { prefix: 'dbu-txs-' },
  d1Resources: ['order'],
  environments: {
    preview: {},
    dev: {},
    production: { branch: 'prod', suffix: '', workersDev: false },
  },
}

test('naming mode: preview suffix -<pr>, dev -dev, production bare', () => {
  const prev = resolveEnv(namedTopology, { preview: 1577 })
  expect(prev.prefix).toBe('dbu-txs-')
  expect(prev.suffix).toBe('-1577')
  expect(prev.pr).toBe(1577)
  const dev = resolveEnv(namedTopology, { stable: 'dev' })
  expect(dev.suffix).toBe('-dev')
  const prod = resolveEnv(namedTopology, { stable: 'prod' }) // branch mapping
  expect(prod.key).toBe('production')
  expect(prod.suffix).toBe('')
  expect(prod.workersDev).toBe(false)
})

test('naming mode render: jména zdrojů dbu-txs-<base><suffix>, workers_dev z env', async () => {
  const w: WorkerDescriptor = {
    base: 'order-service',
    dir: 'services/order',
    main: 'i.ts',
    services: [{ binding: 'SS', target: 'secrets-store' }],
    d1: [{ binding: 'ORDER_D1', resource: 'order' }],
    queueProducers: [{ binding: 'Q', resource: 'notifications' }],
    deployOrder: 0,
  }
  const t = { ...namedTopology, workers: [w] }
  const prev = await read(await renderConfig(w, opts(resolveEnv(t, { preview: 7 }), t)))
  expect(prev.name).toBe('dbu-txs-order-service-7')
  expect(prev.services).toContainEqual({ binding: 'SS', service: 'dbu-txs-secrets-store-7' })
  expect(prev.d1_databases[0].database_name).toBe('dbu-txs-order-7')
  expect(prev.queues.producers[0].queue).toBe('dbu-txs-notifications-7')
  const prod = await read(await renderConfig(w, opts(resolveEnv(t, { stable: 'production' }), t)))
  expect(prod.name).toBe('dbu-txs-order-service')
  expect(prod.d1_databases[0].database_name).toBe('dbu-txs-order')
  expect(prod.workers_dev).toBe(false)
})

test('domainsByEnv: {pr} placeholder + per-env, priorita env.domains > šablona', async () => {
  const gw: WorkerDescriptor = {
    base: 'gateway',
    dir: 'apps/gateway',
    main: 'i.ts',
    customDomain: true,
    domainsByEnv: {
      preview: '{pr}.api.dbutxs.develit.dev',
      dev: 'dev.api.dbutxs.develit.dev',
      production: 'api.txs.devizovaburza.cz',
    },
    deployOrder: 1,
  }
  const t = { ...namedTopology, workers: [gw] }
  const prev = await read(await renderConfig(gw, opts(resolveEnv(t, { preview: 42 }), t)))
  expect(prev.routes).toEqual([{ pattern: '42.api.dbutxs.develit.dev', custom_domain: true }])
  const prod = await read(await renderConfig(gw, opts(resolveEnv(t, { stable: 'production' }), t)))
  expect(prod.routes).toEqual([{ pattern: 'api.txs.devizovaburza.cz', custom_domain: true }])
  // env.domains override vyhrává nad šablonou
  const t2 = {
    ...t,
    environments: { ...t.environments, production: { ...t.environments.production, domains: { gateway: 'override.cz' } } },
  }
  const ovr = await read(await renderConfig(gw, opts(resolveEnv(t2, { stable: 'production' }), t2)))
  expect(ovr.routes).toEqual([{ pattern: 'override.cz', custom_domain: true }])
})

test('queue consumer config: batch/timeout/retries bez DLQ i s DLQ', async () => {
  const w: WorkerDescriptor = {
    base: 'c',
    dir: 'c',
    main: 'i.ts',
    queueConsumers: [
      { resource: 'audit-logs', batchSize: 100 }, // bez retries/DLQ
      { resource: 'queue-bus', maxRetries: 3 }, // retries bez DLQ
      { resource: 'notifications', batchSize: 1, deadLetter: { resource: 'notifications-dlq', maxRetries: 5 } },
    ],
    deployOrder: 0,
  }
  const cfg = await read(await renderConfig(w, opts(resolveEnv(topology, { preview: 9 }))))
  const [audit, bus, notif] = cfg.queues.consumers
  expect(audit).toEqual({ queue: 'pr-9-audit-logs', max_batch_size: 100, max_batch_timeout: 5 })
  expect(bus).toEqual({ queue: 'pr-9-queue-bus', max_batch_size: 10, max_batch_timeout: 5, max_retries: 3 })
  expect(notif).toEqual({
    queue: 'pr-9-notifications',
    max_batch_size: 1,
    max_batch_timeout: 5,
    max_retries: 5,
    dead_letter_queue: 'pr-9-notifications-dlq',
  })
})

test('vpcServices: per-env service_id, chybějící env → throw', async () => {
  const w: WorkerDescriptor = {
    base: 'bank',
    dir: 'b',
    main: 'i.ts',
    vpcServices: [{ binding: 'CBS', serviceIdByEnv: { preview: 'id-dev', production: 'id-prod' } }],
    deployOrder: 0,
  }
  const cfg = await read(await renderConfig(w, opts(resolveEnv(topology, { preview: 2 }))))
  expect(cfg.vpc_services).toEqual([{ binding: 'CBS', service_id: 'id-dev', remote: true }])
  const env = resolveEnv(topology, { stable: 'prod' }) // key 'prod' nemá id
  expect(renderConfig(w, opts(env))).rejects.toThrow("chybí service_id pro env 'prod'")
})

test('workflow limits + version_metadata + observability', async () => {
  const w: WorkerDescriptor = {
    base: 'bank',
    dir: 'b',
    main: 'i.ts',
    workflows: [{ binding: 'SYNC', name: 'bank-sync', className: 'Sync', limits: { steps: 25000 } }],
    versionMetadata: 'CF_VERSION_METADATA',
    deployOrder: 0,
  }
  const t = { ...topology, observability: { enabled: true, head_sampling_rate: 1 } }
  const cfg = await read(await renderConfig(w, opts(resolveEnv(t, { preview: 3 }), t)))
  expect(cfg.workflows[0].limits).toEqual({ steps: 25000 })
  expect(cfg.version_metadata).toEqual({ binding: 'CF_VERSION_METADATA' })
  expect(cfg.observability).toEqual({ enabled: true, head_sampling_rate: 1 })
})

test('lint: sensitive flat var + flat/perEnv kolize; ACCOUNT_ID NEhlásí', () => {
  const lintTopo: Topology = {
    ...topology,
    workers: [
      {
        base: 'a',
        dir: 'a',
        main: 'i.ts',
        vars: { FINBRICKS_BASE_URI: 'https://x', CLOUDFLARE_ACCOUNT_ID: 'acc', FINBRICKS_MERCHANT_ID: 'm' },
        deployOrder: 0,
      },
      { base: 'b', dir: 'b', main: 'i.ts', vars: { TIER: 'x' }, varsByEnv: { prod: { TIER: 'y' } }, deployOrder: 0 },
    ],
  }
  const warnings = lintTopology(lintTopo)
  expect(warnings.some((w) => w.includes("'FINBRICKS_BASE_URI'"))).toBe(true)
  expect(warnings.some((w) => w.includes("'FINBRICKS_MERCHANT_ID'"))).toBe(true) // MERCHANT substring
  expect(warnings.some((w) => w.includes("'CLOUDFLARE_ACCOUNT_ID'"))).toBe(false) // _ID už nehlásí
  expect(warnings.some((w) => w.includes("'TIER'") && w.includes('b:'))).toBe(true)
})

test('lint: r2 v obou listech → warning', () => {
  const t: Topology = { ...topology, r2Resources: ['documents'], sharedR2Resources: ['documents'], workers: [] }
  expect(lintTopology(t).some((w) => w.includes("r2 'documents'"))).toBe(true)
})

test('lint: duplicitní service binding (services + externalServices) → warning', () => {
  const t: Topology = {
    ...topology,
    r2Resources: [],
    sharedR2Resources: [],
    workers: [
      {
        base: 'g',
        dir: 'g',
        main: 'i.ts',
        services: [{ binding: 'MDM_GATEWAY', target: 'mdm' }],
        externalServices: [{ binding: 'MDM_GATEWAY', namesByEnv: { preview: 'x' } }],
        deployOrder: 0,
      },
    ],
  }
  expect(lintTopology(t).some((w) => w.includes("'MDM_GATEWAY'") && w.includes('kolize'))).toBe(true)
})

test('parsePr: legacy prefix vs naming suffix mode', async () => {
  const { parsePr } = await import('./prefix')
  expect(parsePr('pr-123-gateway', topology)).toBe(123)
  expect(parsePr('dev-gateway', topology)).toBe(null)
  expect(parsePr('dbu-txs-order-1577', namedTopology)).toBe(1577)
  expect(parsePr('dbu-txs-order-dev', namedTopology)).toBe(null) // stable suffix nematchuje
  expect(parsePr('dbu-txs-order', namedTopology)).toBe(null) // production bare
  expect(parsePr('other-project-55', namedTopology)).toBe(null) // cizí prefix
})
