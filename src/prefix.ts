// Package PR-keying invariant: per-PR zdroje mají prefix `pr-<N>-`. Centralizováno na JEDNOM místě
// → gc enumerace i entry skripty sdílí stejnou konvenci (žádný drift mezi formátem a parsováním).
export const prefixFor = (pr: string | number): string => `pr-${pr}-`

// Vytáhne PR číslo z názvu zdroje (`pr-123-gateway` → 123), nebo null když nematchuje.
export const parsePrefix = (name: string): number | null => {
  const m = name.match(/^pr-(\d+)-/)
  return m ? Number(m[1]) : null
}
