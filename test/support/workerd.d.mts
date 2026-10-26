// The types of workerd.mjs, for the suites in TypeScript.

export function freePort(): Promise<number>

export type Workerd = {
  origin: string
  previewOrigin: string
  port: number
  previewPort: number
  logs(): string
  restart(): Promise<void>
  stop(): Promise<void>
}

export function startWorkerd(options?: {
  vars?: Record<string, string> | ((ports: { port: number, previewPort: number }) => Record<string, string>)
  quiet?: boolean
  containers?: boolean
  port?: number
  previewPort?: number
  extra?: string
}): Promise<Workerd>
