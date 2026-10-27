// Chinese, Japanese and Korean text has no spaces, and Postgres's own text
// search can't split it: the `simple` parser keeps a whole run as one word.
// Where no CJK tokenizer is installed (Lakebase Search's, store.mjs), the
// text is rewritten before it's indexed: each CJK run becomes its overlapping
// pairs of characters and its last character alone ("数据库" → "数据 据库 库"),
// pg_bigm's idea, done before the text reaches Postgres. Other text is left to
// the parser.

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g
const IS_CJK = new RegExp(`^${CJK.source}$`)

const pairs = (run: string): string => {
  const chars = [...run]
  if (chars.length === 1) return run
  return [...chars.slice(0, -1).map((c, i) => c + chars[i + 1]), chars.at(-1)].join(' ')
}

export const grams = (text: string): string =>
  text
    .replace(CJK, run => ` ${pairs(run)} `)
    .replace(/\s+/g, ' ')
    .trim()

// A query's words, each one required, as what Postgres turns into a tsquery:
// a phrase of the word's pairs (without the run's last character alone, which
// only indexed text carries), or a prefix for a single character, which finds
// it at any place in a run. At most 8 words.
export type QueryWord = { prefix: string } | { phrase: string }

export function queryWords(input: string): QueryWord[] {
  const out: QueryWord[] = []
  for (const word of String(input).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    if ([...word].length === 1 && IS_CJK.test(word)) out.push({ prefix: word })
    else {
      const phrase = word.replace(CJK, run => ` ${[...run].length === 1 ? run : pairs(run).split(' ').slice(0, -1).join(' ')} `).trim()
      if (phrase) out.push({ phrase })
    }
  }
  return out
}
