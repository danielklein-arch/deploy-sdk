import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, test } from 'bun:test'
import { hasSqlMigrations } from './cf-client'

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
