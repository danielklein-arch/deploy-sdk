// Statická kontrola topologie — varuje na vzory vedoucí k env-resetu (dbu-txs FINBRICKS past:
// env-specific hodnota jako flat `vars` → deploy přepíše prod na default) + config footguny. Advisory.
import type { Topology } from './types'

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

  for (const w of topology.workers) {
    // Duplicitní service binding napříč services + externalServices → wrangler last-wins, tichá chyba.
    const seen = new Set<string>()
    for (const b of [...(w.services ?? []), ...(w.externalServices ?? [])]) {
      if (seen.has(b.binding))
        warnings.push(`${w.base}: service binding '${b.binding}' je 2× (services/externalServices) → kolize`)
      seen.add(b.binding)
    }

    const flat = w.vars ?? {}
    const perEnvKeys = new Set<string>()
    for (const env of Object.values(w.varsByEnv ?? {})) for (const k of Object.keys(env)) perEnvKeys.add(k)

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
