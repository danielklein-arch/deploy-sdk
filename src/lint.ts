// Statická kontrola topologie — varuje na vzory vedoucí k env-resetu (dbu-txs FINBRICKS past:
// env-specific hodnota jako flat `vars` → deploy přepíše prod na default) + config footguny. Advisory.
import type { Topology } from './types'
import { resolveEnv, nameFor, sharedNameFor } from './env'

// Názvy, co typicky nesou env-specific endpoint/credential (riziko když jsou flat).
// Pozn.: `_ID$` ZÁMĚRNĚ vynecháno (ACCOUNT_ID/STORE_ID jsou legitimně flat); MERCHANT chytneme substringem.
const SENSITIVE = /MERCHANT|(_URI|_URL|_KEY|_SECRET|_TOKEN)$/i

export function lintTopology(topology: Topology): string[] {
  const warnings: string[] = []

  // R2: resource v r2Resources I sharedR2Resources → nejednoznačné (provision vytvoří oba, render binduje
  // jen shared, per-PR bucket se zbytečně točí → data-isolation překvapení).
  const shared = new Set(topology.sharedR2Resources ?? [])
  for (const r of topology.r2Resources)
    if (shared.has(r)) warnings.push(`r2 '${r}' je v r2Resources i sharedR2Resources → vyber jen jeden (preview leak)`)

  // AI Gateway: dual-list (mirror R2 checku).
  const aigShared = new Set(topology.sharedAiGatewayResources ?? [])
  for (const r of topology.aiGatewayResources ?? [])
    if (aigShared.has(r))
      warnings.push(`ai-gateway '${r}' je v aiGatewayResources i sharedAiGatewayResources → vyber jen jeden`)

  // Gateway id constraint: [a-z0-9-], max 64 — kontrola nejdelších finálních jmen
  // (preview s 6-místným PR + všechny stable envy; klíč 'preview' není stable env → skip).
  const AIG_ID = /^[a-z0-9-]+$/
  const aigEntries = [
    ...(topology.aiGatewayResources ?? []).map((r) => [r, false] as const),
    ...(topology.sharedAiGatewayResources ?? []).map((r) => [r, true] as const),
  ]
  for (const [r, isShared] of aigEntries) {
    const previewEnv = resolveEnv(topology, { preview: 999999 })
    const names = [
      isShared ? sharedNameFor(previewEnv, r) : nameFor(previewEnv, r),
      ...Object.keys(topology.environments)
        .filter((k) => k !== 'preview')
        .map((k) => nameFor(resolveEnv(topology, { stable: k }), r)),
    ]
    for (const n of names) {
      if (!AIG_ID.test(n)) warnings.push(`ai-gateway '${r}': jméno '${n}' — gateway id povoluje jen [a-z0-9-]`)
      if (n.length > 64) warnings.push(`ai-gateway '${r}': jméno '${n}' přes 64 znaků (CF limit)`)
    }
  }
  const aigAll = new Set([...(topology.aiGatewayResources ?? []), ...(topology.sharedAiGatewayResources ?? [])])

  for (const w of topology.workers) {
    // Duplicitní service binding napříč services + externalServices → wrangler last-wins, tichá chyba.
    const seen = new Set<string>()
    for (const b of [...(w.services ?? []), ...(w.externalServices ?? [])]) {
      if (seen.has(b.binding))
        warnings.push(`${w.base}: service binding '${b.binding}' je 2× (services/externalServices) → kolize`)
      seen.add(b.binding)
    }

    // crons + cronsByEnv současně → flat se ignoruje celé (whole-field precedence), je mrtvý.
    if (w.crons && w.cronsByEnv)
      warnings.push(`${w.base}: 'crons' i 'cronsByEnv' → crons se ignoruje; nech jen cronsByEnv`)

    // injectUrlOf.path bez úvodního '/' → slepená URL (https://domena feeds/...).
    if (w.injectUrlOf?.path && !w.injectUrlOf.path.startsWith('/'))
      warnings.push(`${w.base}: injectUrlOf.path '${w.injectUrlOf.path}' nezačíná '/' → slepená URL`)

    // accessByEnv: preview wildcard se odvozuje z domainsByEnv.preview šablony s {pr}.
    for (const [envKey, policy] of Object.entries(w.accessByEnv ?? {})) {
      if (envKey === 'preview' && !w.domainsByEnv?.preview?.includes('{pr}'))
        warnings.push(`${w.base}: accessByEnv.preview vyžaduje domainsByEnv.preview s '{pr}' (wildcard app)`)
      if (!policy.emailDomains?.length && !policy.serviceToken)
        warnings.push(`${w.base}: accessByEnv.${envKey} bez emailDomains i serviceToken → app nikoho nepustí`)
    }

    const flat = w.vars ?? {}
    const perEnvKeys = new Set<string>()
    for (const env of Object.values(w.varsByEnv ?? {})) for (const k of Object.keys(env)) perEnvKeys.add(k)

    for (const g of w.aiGateways ?? []) {
      if (!aigAll.has(g.resource))
        warnings.push(
          `${w.base}: aiGateways '${g.binding}' → resource '${g.resource}' není v aiGatewayResources ani sharedAiGatewayResources`,
        )
      // Gateway var se injektuje renderem a vyhrává → ruční var stejného jména je mrtvý.
      if (flat[g.binding] !== undefined || perEnvKeys.has(g.binding))
        warnings.push(`${w.base}: var '${g.binding}' koliduje s aiGateways bindingem → gateway hodnota vyhraje`)
    }

    for (const k of Object.keys(flat)) {
      // klíč současně flat i per-env → flat může maskovat per-env (nejednoznačný zdroj).
      if (perEnvKeys.has(k))
        warnings.push(`${w.base}: var '${k}' je flat i ve varsByEnv → flat může maskovat; nech ho jen ve varsByEnv`)
      // sensitive-looking flat var bez per-env override → pokud se má lišit per env, je to past.
      else if (SENSITIVE.test(k))
        warnings.push(`${w.base}: var '${k}' vypadá env-specific, ale je flat (stejná hodnota všude) → zvaž varsByEnv`)
    }
  }
  return warnings
}
