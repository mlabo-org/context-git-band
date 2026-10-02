export type GitInfo = {
  branch: string
  dirty: number
  ahead: number | null
  behind: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-git-band': { git: GitInfo | null; isHidden: boolean }
  }
}
