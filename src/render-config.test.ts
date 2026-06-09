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

const opts = (env: ReturnType<typeof resolveEnv>) => ({
  env,
  ids: { d1: {}, kv: {} },
  previewZone: topology.previewZone,
  secretsStoreId: topology.secretsStoreId,
  compat: topology.compat,
  sharedR2Resources: topology.sharedR2Resources,
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
