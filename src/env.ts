// Resolve prostředí (preview nebo stable) z topologie. Pure — žádné process.env.
import type { Topology, DeployEnv, EnvConfig } from './types'

export type EnvSelector = { preview: number } | { stable: string }

// Finální jméno zdroje/workeru pro env. Legacy: `${prefix}${base}`; naming mode: `${prefix}${base}${suffix}`.
export const nameFor = (env: DeployEnv, base: string): string => `${env.prefix}${base}${env.suffix}`

// Jméno shared-collapse zdroje (sharedR2 / sharedAiGateway): preview všech PR sdílí `preview-${base}`,
// stable per-env jméno.
export const sharedNameFor = (env: DeployEnv, base: string): string =>
  env.ephemeral ? `preview-${base}` : nameFor(env, base)

// Resolved jméno AI Gateway pro binding — shared vs per-PR podle topology listů.
export const aiGatewayName = (env: DeployEnv, resource: string, topology: Topology): string =>
  topology.sharedAiGatewayResources?.includes(resource) ? sharedNameFor(env, resource) : nameFor(env, resource)

// Stable lookup: přímý klíč → fallback scan podle EnvConfig.branch (branch 'prod' → env 'production').
function findStable(topology: Topology, name: string): { key: string; cfg: EnvConfig } {
  const direct = topology.environments[name]
  if (direct) return { key: name, cfg: direct }
  for (const [key, cfg] of Object.entries(topology.environments))
    if (cfg.branch === name) return { key, cfg }
  throw new Error(
    `neznámé stálé prostředí '${name}' — topology.environments klíče: ${Object.keys(topology.environments).join(', ')} (matchuje se klíč i .branch)`,
  )
}

export function resolveEnv(topology: Topology, sel: EnvSelector): DeployEnv {
  const naming = topology.naming
  if ('preview' in sel) {
    // Preview může mít env-level defaulty přes topology.environments.preview (sandbox vars/secrets/domains).
    // Per-PR identita: prefix `<N>-`, naming mode suffix `-<N>`.
    const previewCfg = topology.environments.preview
    return {
      name: `pr-${sel.preview}`,
      key: 'preview',
      prefix: naming ? naming.prefix : `${sel.preview}-`,
      suffix: naming ? `-${sel.preview}` : '',
      pr: sel.preview,
      workersDev: previewCfg?.workersDev ?? true,
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
    prefix: naming ? naming.prefix : (cfg.prefix ?? `${key}-`),
    suffix: naming ? (cfg.suffix ?? `-${key}`) : '',
    workersDev: cfg.workersDev ?? true,
    ephemeral: false,
    vars: { ENVIRONMENT: key, ...cfg.vars },
    domains: cfg.domains ?? {},
    secrets: cfg.secrets ?? {},
    accountId: cfg.accountId,
    apiTokenEnv: cfg.apiTokenEnv,
    secretsStoreId: cfg.secretsStoreId ?? topology.secretsStoreId,
  }
}

// Custom-domain FQDN workeru. Priorita: env override (prod apex) → per-worker šablona
// (domainsByEnv[env.key], `{pr}` placeholder) → default `${nameFor}.${previewZone}`.
export function resolveDomain(env: DeployEnv, base: string, topology: Topology): string {
  const override = env.domains[base]
  if (override) return override
  const tpl = topology.workers.find((w) => w.base === base)?.domainsByEnv?.[env.key]
  if (tpl) {
    if (tpl.includes('{pr}') && env.pr === undefined)
      throw new Error(`domainsByEnv '${base}'/'${env.key}': '{pr}' placeholder mimo preview env`)
    return tpl.replaceAll('{pr}', String(env.pr))
  }
  return `${nameFor(env, base)}.${topology.previewZone}`
}
