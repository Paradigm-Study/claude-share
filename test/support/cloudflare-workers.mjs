// What server/worker.ts takes from `cloudflare:workers`, as Node runs it.
// workerd's DurableObject keeps ctx and env; RPC itself is the test's own
// stub, calling the object's methods directly.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}
