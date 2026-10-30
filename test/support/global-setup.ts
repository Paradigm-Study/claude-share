// Once a run, before any suite: the dashboard built from the web/ in this
// checkout, so the Workers under wrangler dev serve what the tests read.
import { buildWeb } from './workerd.ts'

export default function setup() {
  buildWeb({ fresh: true })
}
