export type GitInfo = {
  branch: string
  dirty: number
  ahead: number | null
  behind: number
  otherHostOnly: boolean
}

export type QuotaWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type QuotaReading = {
  windows: QuotaWindow[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-git-band': { git: GitInfo | null; isHidden: boolean; isCompacting: boolean; compactAt: number | null; quota: QuotaReading | null }
  }
}
