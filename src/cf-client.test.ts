import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, test } from 'bun:test'
import { hasSqlMigrations, aiGatewayCreateBody, accessAppCreateBody } from './cf-client'

test('hasSqlMigrations: dir s .sql → true, bez dir / prázdný → false', () => {
  const base = `${tmpdir()}/dsdk-hasmig-test`
  rmSync(base, { recursive: true, force: true })

  mkdirSync(`${base}/withmig/migrations`, { recursive: true })
  writeFileSync(`${base}/withmig/migrations/0001_init.sql`, 'SELECT 1;')
  mkdirSync(`${base}/emptymig/migrations`, { recursive: true })
  mkdirSync(`${base}/nomig`, { recursive: true })

  expect(hasSqlMigrations(`${base}/withmig`)).toBe(true)
  expect(hasSqlMigrations(`${base}/emptymig`)).toBe(false) // dir existuje, ale žádné .sql
  expect(hasSqlMigrations(`${base}/nomig`)).toBe(false) // žádný migrations/ dir

  rmSync(base, { recursive: true, force: true })
})

test('aiGatewayCreateBody: id + required defaulty (cache off, logy on, rate limiting off)', () => {
  expect(aiGatewayCreateBody('pr-7-ai')).toEqual({
    id: 'pr-7-ai',
    cache_invalidate_on_update: true,
    cache_ttl: 0,
    collect_logs: true,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
  })
})

test('accessAppCreateBody: email policy / service token policy / obě', () => {
  const email = accessAppCreateBody('*.app.example.dev', { emailDomains: ['develit.io'] })
  expect(email).toEqual({
    name: '*.app.example.dev',
    type: 'self_hosted',
    domain: '*.app.example.dev',
    policies: [
      {
        name: '*.app.example.dev email',
        decision: 'allow',
        include: [{ email_domain: { domain: 'develit.io' } }],
      },
    ],
  })

  const token = accessAppCreateBody('dev.app.example.dev', { serviceToken: true })
  expect(token.policies).toEqual([
    {
      name: 'dev.app.example.dev service token',
      decision: 'non_identity',
      include: [{ any_valid_service_token: {} }],
    },
  ])

  const both = accessAppCreateBody('x.dev', { emailDomains: ['a.io', 'b.io'], serviceToken: true })
  expect(both.policies).toHaveLength(2)
  expect(both.policies[0]?.include).toEqual([
    { email_domain: { domain: 'a.io' } },
    { email_domain: { domain: 'b.io' } },
  ])
})
