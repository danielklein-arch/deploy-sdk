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

test('lint: sensitive flat var → warning; flat+perEnv → warning', () => {
  const lintTopo: Topology = {
    ...topology,
    workers: [
      { base: 'a', dir: 'a', main: 'i.ts', vars: { FINBRICKS_BASE_URI: 'https://x' }, deployOrder: 0 },
      {
        base: 'b',
        dir: 'b',
        main: 'i.ts',
        vars: { TIER: 'x' },
        varsByEnv: { prod: { TIER: 'y' } },
        deployOrder: 0,
      },
    ],
  }
  const warnings = lintTopology(lintTopo)
  expect(warnings.some((w) => w.includes("'FINBRICKS_BASE_URI'"))).toBe(true)
  expect(warnings.some((w) => w.includes('a:'))).toBe(true)
  expect(warnings.some((w) => w.includes("'TIER'") && w.includes('b:'))).toBe(true)
})
