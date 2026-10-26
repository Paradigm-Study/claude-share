// Makes or brings up to date session traces's tables (server/traces/store.ts)
// in the Postgres database the Worker's TRACES_DB Hyperdrive binding names.
// Safe to run again. Needs Node 22.18 or newer (it loads TypeScript). The
// connection string is the person's to give:
//
//   TRACES_DATABASE_URL='postgresql://…' node scripts/traces-migrate.mjs

import pg from 'pg'
import { migrate } from '../server/traces/store.ts'

const url = process.env.TRACES_DATABASE_URL
if (!url) {
  console.log('FAIL TRACES_DATABASE_URL is not set: the traces database\'s connection string')
  process.exit(1)
}
const db = new pg.Client({ connectionString: url })
await db.connect()
try {
  const { cjk } = await migrate(db)
  console.log(`OK traces tables ready; Chinese keywords by ${cjk ? "Lakebase Search's tokenizer and BM25" : 'pairs of characters (no Lakebase Search here)'}`)
} finally {
  await db.end()
}
