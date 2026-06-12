// Package PR-keying invariant. Centralizováno na JEDNOM místě → gc enumerace i entry skripty
// sdílí stejnou konvenci (žádný drift mezi formátem a parsováním).
// Legacy prefix mode: `<N>-gateway` (driv `pr-<N>-gateway`). Naming (suffix) mode: `<projectPrefix>gateway-<N>`.
import type { Topology } from './types'

export const prefixFor = (pr: string | number): string => `${pr}-`

// Vytáhne PR číslo z názvu zdroje (`123-gateway` → 123; toleruje i legacy `pr-123-gateway`).
export const parsePrefix = (name: string): number | null => {
  const m = name.match(/^(?:pr-)?(\d+)-/)
  return m ? Number(m[1]) : null
}

// Mode-aware parse: legacy přes parsePrefix; naming mode = projektový prefix + numerický suffix.
// POZOR: stable suffixy (-dev/-staging/'') nejsou numerické → nematchují (správně, gc je nesmí žrát).
export function parsePr(name: string, topology: Topology): number | null {
  const naming = topology.naming
  if (!naming) return parsePrefix(name)
  if (!name.startsWith(naming.prefix)) return null
  const m = name.match(/-(\d+)$/)
  return m ? Number(m[1]) : null
}
