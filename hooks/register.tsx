import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitInfo } from '../types'

const git = atom({ plugin: 'context-git-band', key: 'git' } as const, null)
const isHidden = atom({ plugin: 'context-git-band', key: 'isHidden' } as const, false)

// The context window's fill as weather, with the guide's thresholds
const weather = (percent: number) => {
  if (percent >= 90) return { icon: '↯', label: 'Compact Soon', color: 'red' }
  if (percent >= 75) return { icon: '☇', label: 'Storm', color: 'red' }
  if (percent >= 50) return { icon: '☂', label: 'Showers', color: 'yellow' }
  if (percent >= 25) return { icon: '☁', label: 'Cloudy', color: 'cyan' }
  return { icon: '☀', label: 'Clear', color: 'green' }
}

const kilo = (n: number) => `${Math.round(n / 1000)}k`

// `git status --porcelain=v1 -b`: first line is the branch, the rest are changed files
const parseStatus = (stdout: string): GitInfo => {
  const [head = '', ...rest] = stdout.split('\n').filter(line => line !== '')
  const branchLine = head.replace(/^## /, '')
  const name = branchLine.split('...')[0] ?? branchLine
  const hasUpstream = branchLine.includes('...')
  const ahead = /ahead (\d+)/.exec(branchLine)
  const behind = /behind (\d+)/.exec(branchLine)

  return {
    branch: name.startsWith('No commits yet on ') ? name.slice(18) : name,
    dirty: rest.length,
    ahead: hasUpstream ? (ahead ? Number(ahead[1]) : 0) : null,
    behind: behind ? Number(behind[1]) : 0,
  }
}

const EDITING_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit']

let lastRefresh = 0

// Reads git into the shared value; a folder that is not a repo, or a host
// that cannot run commands, leaves the band showing the context part alone.
async function refreshGit($: EngineInterface, force: boolean) {
  const now = await $.clock.now()
  if (!force && now - lastRefresh < 2000) return
  lastRefresh = now

  try {
    const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain=v1', '-b'], {
      timeoutMs: 5000,
    })
    await update($, git, () => (exitCode === 0 ? parseStatus(stdout) : null))
  } catch {
    await update($, git, () => null)
  }
}

let hasWarned = false

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await refreshGit($, true)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await refreshGit($, false)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDITING_TOOLS.includes(e.tool)) await refreshGit($, false)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    await refreshGit($, true)

    const { context } = await $.session.usage()
    const percent = context.percent ?? 0
    if (percent >= 90 && !hasWarned) {
      hasWarned = true
      $.ui.toast(`Context ${percent}% full: compact soon`)
    } else if (percent < 80) {
      hasWarned = false
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const { context } = await $.session.usage()
    const info = await read($, git)
    const { Box, Button, Text } = $.ui.resolve(e)

    const hasContext = context.percent !== undefined
    const w = weather(context.percent ?? 0)

    return (
      <Box>
        {hasContext ? (
          <Text color={w.color}>
            {w.icon} {w.label} {context.percent}%{' '}
          </Text>
        ) : (
          <Text dimColor>ctx -- </Text>
        )}
        {hasContext && context.tokens !== undefined ? (
          <Text dimColor>
            ({kilo(context.tokens)}/{kilo(context.window)}){' '}
          </Text>
        ) : null}
        {info === null ? null : (
          <Text>
            <Text dimColor>│ </Text>
            <Text bold>{info.branch}</Text>
            <Text color={info.dirty > 0 ? 'yellow' : 'green'}>
              {info.dirty > 0 ? ` ● ${info.dirty} 未コミット` : ' ✔ クリーン'}
            </Text>
            {info.ahead === null ? (
              <Text dimColor> · upstreamなし</Text>
            ) : info.ahead > 0 ? (
              <Text color="yellow"> · ↑{info.ahead} 未push</Text>
            ) : null}
            {info.behind > 0 ? <Text color="cyan"> · ↓{info.behind}</Text> : null}
            <Text> </Text>
          </Text>
        )}
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
