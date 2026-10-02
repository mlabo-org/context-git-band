# context-git-band

A Claude Code mod (needs Claude Code 2.1.287 or later). It draws one line above the prompt, in the terminal and in the desktop Code tab:

```
☂ Showers 54% (108k/200k) │ main ● 5 未コミット · ↑2 未push  [Hide]
```

- Context window fill as weather: ☀ Clear (under 25%), ☁ Cloudy, ☂ Showers (50%), ☇ Storm (75%), ↯ Compact Soon (90%). It toasts once when the fill reaches 90%.
- Git state of the session's folder: branch, uncommitted files, unpushed commits (↑), commits behind (↓). A branch with no upstream shows `GitHub未公開`, or `upstreamなし` when the repo's remotes are all non-GitHub. It is read at session start, on each prompt, after Bash/Edit/Write tool calls (at most once per 2 s) and when a turn ends. In a folder that is not a Git repository, or on a host that cannot run commands (`$.process` is CLI only), the line shows the context part alone.
- `Hide` removes the line until the mod reloads.

Claude Code only; Codex has no mods. The source of truth is this directory; install it through the `suzuki-local-plugins` marketplace (`claude-plugin-refresh`).

## Check

```bash
claude plugin validate ~/plugins/context-git-band
```
