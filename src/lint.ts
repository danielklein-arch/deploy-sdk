// Statická kontrola topologie — varuje na vzory vedoucí k env-resetu (dbu-txs FINBRICKS past:
// env-specific hodnota jako flat `vars` → deploy přepíše prod na default). Advisory, neblokuje deploy.
import type { Topology } from './types'

// Názvy, co typicky nesou env-specific endpoint/credential (riziko když jsou flat).
const SENSITIVE = /(_URI|_URL|_KEY|_SECRET|_TOKEN|MERCHANT|_ID)$/i

export function lintTopology(topology: Topology): string[] {
  const warnings: string[] = []
  for (const w of topology.workers) {
    const flat = w.vars ?? {}
    const perEnvKeys = new Set<string>()
    for (const env of Object.values(w.varsByEnv ?? {})) for (const k of Object.keys(env)) perEnvKeys.add(k)

    for (const k of Object.keys(flat)) {
      // 1) klíč současně flat i per-env → flat může maskovat per-env (nejednoznačný zdroj).
      if (perEnvKeys.has(k))
        warnings.push(`${w.base}: var '${k}' je flat i ve varsByEnv → flat může maskovat; nech ho jen ve varsByEnv`)
      // 2) sensitive-looking flat var bez per-env override → pokud se má lišit per env, je to past.
      else if (SENSITIVE.test(k))
        warnings.push(`${w.base}: var '${k}' vypadá env-specific, ale je flat (stejná hodnota všude) → zvaž varsByEnv`)
    }
  }
  return warnings
}
