// "7d", "12h", "30m" back from now, or a date.
export function timeOf(text: unknown, now = Date.now()): number | undefined {
  if (!text) return undefined
  const span = /^(\d+)\s*([dhm])$/.exec(String(text).trim())
  if (span) return now - Number(span[1]) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 } as Record<string, number>)[span[2]!]!
  const t = Date.parse(String(text))
  return Number.isFinite(t) ? t : undefined
}
