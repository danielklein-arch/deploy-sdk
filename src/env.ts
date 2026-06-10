// Resolve prostředí (preview nebo stable) z topologie. Pure — žádné process.env.
import type { Topology, DeployEnv, EnvConfig } from './types'

export type EnvSelector = { preview: number } | { stable: string }

// Stable lookup: přímý klíč → fallback scan podle EnvConfig.branch (branch 'prod' → env 'production').
function findStable(topology: Topology, name: string): { key: string; cfg: EnvConfig } {
  const direct = topology.environments[name]
  if (direct) return { key: name, cfg: direct }
  for (const [key, cfg] of Object.entries(topology.environments))
    if (cfg.branch === name) return { key, cfg }
  throw new Error(`neznámé stálé prostředí '${name}' (topology.environments — klíč ani branch)`)
}

export function resolveEnv(topology: Topology, sel: EnvSelector): DeployEnv {
  if ('preview' in sel) {
    // Preview může mít env-level defaulty přes topology.environments.preview (sandbox vars/secrets/domains).
    // Prefix zůstává per-PR `pr-<N>-` (ephemeral); previewCfg.prefix se ignoruje.
    const previewCfg = topology.environments.preview
    return {
      name: `pr-${sel.preview}`,
      key: 'preview',
      prefix: `pr-${sel.preview}-`,
      ephemeral: true,
      vars: { ENVIRONMENT: 'preview', ...previewCfg?.vars },
      domains: previewCfg?.domains ?? {},
      secrets: previewCfg?.secrets ?? {},
      accountId: previewCfg?.accountId,
      apiTokenEnv: previewCfg?.apiTokenEnv,
      secretsStoreId: previewCfg?.secretsStoreId ?? topology.secretsStoreId,
    }
  }
  const { key, cfg } = findStable(topology, sel.stable)
  return {
    name: key,
    key,
    prefix: cfg.prefix ?? `${key}-`,
    ephemeral: false,
    vars: { ENVIRONMENT: key, ...cfg.vars },
    domains: cfg.domains ?? {},
    secrets: cfg.secrets ?? {},
    accountId: cfg.accountId,
    apiTokenEnv: cfg.apiTokenEnv,
    secretsStoreId: cfg.secretsStoreId ?? topology.secretsStoreId,
  }
}

// Custom-domain FQDN workeru: env override (prod apex) nebo default `${prefix}${base}.${zone}`.
export const resolveDomain = (env: DeployEnv, base: string, previewZone: string): string =>
  env.domains[base] ?? `${env.prefix}${base}.${previewZone}`
