# context-git-band

A Claude Code mod (needs Claude Code 2.1.287 or later). It draws one line above the prompt, in the terminal and in the desktop Code tab:

```
☂ Showers 54% (108k/200k) │ 5h 残97% 週 残55% │ main ● [5 未コミット] · ↑2 未push  [Hide]
```

- Context window fill as weather: ☀ Clear (under 25%), ☁ Cloudy, ☂ Showers (50%), ☇ Storm (75%), ↯ Compact Soon (90%). It toasts once when the fill reaches 90%.
- Subscription quota left in the 5-hour and weekly windows, as remaining percent like mini-system-monitor-rs: yellow at 25% or less, red at 10% or less. Two sources, the newer reading shown:
  - this session's own API responses (`session.measure`'s `rateLimits`), shown the moment a window moves a whole point;
  - the account usage endpoint `https://api.anthropic.com/api/oauth/usage` (the one mini-system-monitor-rs reads), so use from other sessions shows too. It is fetched through `$.http.fetch` with the session's own credential (`$.session.authorize()`; the token never reaches the mod), at session start, when a turn ends (at most once a minute) and otherwise every 3 minutes; a failure or 429 doubles the wait up to 15 minutes. The result, the last fetch time and the backoff are kept in the plugin's `$.store`, which every session reads, so open sessions share one fetch. The endpoint is undocumented and may change or stop working.
  Nothing shows until one of them has a reading, nor off a subscription (an API key).
- Git state of the session's folder: branch, uncommitted files, unpushed commits (↑), commits behind (↓). A branch with no upstream shows `GitHub未公開`, or `upstreamなし` when the repo's remotes are all non-GitHub. It is read at session start, on each prompt, after Bash/Edit/Write tool calls (at most once per 2 s) and when a turn ends. In a folder that is not a Git repository, or on a host that cannot run commands (`$.process` is CLI only), the line shows the context part alone.
- When there are uncommitted files, the count is a button: pressing it submits `未コミットの変更をコミットして` as your prompt, so the session starts the commit (queued until the current turn ends).
- `Hide` collapses the line to a small `▸ ctx/git` button; press it to bring the line back.

Claude Code only; Codex has no mods. The source of truth is this directory; install it through the `suzuki-local-plugins` marketplace (`claude-plugin-refresh`).

## Check

```bash
claude plugin validate ~/plugins/context-git-band
```
