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

// The band's own words, as templates with {placeholders}
export type Words = {
  week: string
  quotaAlt: string
  uncommitted: string
  commitPrompt: string
  clean: string
  noUpstream: string
  notOnGitHub: string
  unpushed: string
  compactSoon: string
  compactSkipped: string
  compactFailed: string
}

declare module 'claude-code' {
  interface PluginState {
    'context-git-band': { git: GitInfo | null; isHidden: boolean; isCompacting: boolean; compactAt: number | null; language: string | null; appLanguage: string | null; translations: Record<string, Words> | null; quota: QuotaReading | null }
  }
}
