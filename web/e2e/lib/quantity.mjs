/** Kubernetes quantities as numbers: `2Gi` → 2147483648, `500m` → 0.5. */
export function quantityBytes(value) {
  if (value === undefined || value === null) return 0
  const match = String(value).trim().match(/^([0-9.]+)([a-zA-Z]*)$/)
  if (!match) return 0
  const factors = { '': 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }
  return parseFloat(match[1]) * (factors[match[2]] ?? 1)
}
