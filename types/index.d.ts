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

// The language of the band's own words
export type Language = 'ja' | 'en'

declare module 'claude-code' {
  interface PluginState {
    'context-git-band': { git: GitInfo | null; isHidden: boolean; isCompacting: boolean; compactAt: number | null; language: Language | null; appLanguage: Language | null; quota: QuotaReading | null }
  }
}
