// What server/worker/ takes from `cloudflare:workers`, as Node runs it.
// workerd's DurableObject keeps ctx and env; RPC itself is the test's own
// stub, calling the object's methods directly.
export class DurableObject {
  ctx: unknown
  env: unknown
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx
    this.env = env
  }
}
