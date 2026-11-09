export type ModelRow = {
  model: string
  tokens: number
  cacheRead: number
  fiveTokens: number
}

export type SessionRow = {
  id: string
  project: string
  title: string
  tokens: number
  cacheRead: number
  fiveTokens: number
  lastMs: number
  models: Record<string, number>
}

/** What hooks/scan.py prints, plus when it ran. */
export type Report = {
  sessions: SessionRow[]
  models: ModelRow[]
  tokens: number
  cacheRead: number
  fiveTokens: number
  scannedAt: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-mod': { report: Shaped<Report | null>; limits: Limit[] }
  }
}
