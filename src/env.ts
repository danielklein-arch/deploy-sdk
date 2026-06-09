// Resolve prostředí (preview nebo stable) z topologie. Pure — žádné process.env.
import type { Topology, DeployEnv } from './types'

export type EnvSelector = { preview: number } | { stable: string }

export function resolveEnv(topology: Topology, sel: EnvSelector): DeployEnv {
  if ('preview' in sel) {
    return {
      name: `pr-${sel.preview}`,
      prefix: `pr-${sel.preview}-`,
      ephemeral: true,
      vars: { ENVIRONMENT: 'preview' },
      domains: {},
      secrets: {},
    }
  }
  const cfg = topology.environments[sel.stable]
  if (!cfg) throw new Error(`neznámé stálé prostředí '${sel.stable}' (topology.environments)`)
  return {
    name: sel.stable,
    prefix: cfg.prefix ?? `${sel.stable}-`,
    ephemeral: false,
    vars: { ENVIRONMENT: sel.stable, ...cfg.vars },
    domains: cfg.domains ?? {},
    secrets: cfg.secrets ?? {},
  }
}

// Custom-domain FQDN workeru: env override (prod apex) nebo default `${prefix}${base}.${zone}`.
export const resolveDomain = (env: DeployEnv, base: string, previewZone: string): string =>
  env.domains[base] ?? `${env.prefix}${base}.${previewZone}`
