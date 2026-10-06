# context-git-band

A Claude Code mod (needs Claude Code 2.1.287 or later). It draws one line above the prompt, in the terminal and in the desktop Code tab:

```
☂ Showers 54% (108k/200k) │ 5h ████████▊░ 88% 週 ███████▋░░ 77% │ main ● [5 未コミット] · ↑2 未push  [Hide]
```

- Context window fill as weather, as a share of the model's whole window: ☀ Clear (under 25%), ☁ Cloudy, ☂ Showers (50%), ☇ Storm (75%), ↯ Compact Soon (90%).
- 50k tokens before Claude Code's own auto-compaction, between turns, the weather part is drawn as a link (`☂ Showers 60% (120k/200k) ⟲ compact`), and a toast says so once: pressing the link compacts the conversation, the same call `/compact` makes, and the band shows `⟳ Compacting…` until it ends. The auto-compaction point is read from the engine each turn (`autoCompactThreshold` of the `/context` breakdown, estimated locally); measured, it is the window less 33k, so the link comes at 117k of 200k (58.5%) and 917k of 1M. With auto-compaction off the window itself is the limit. While a turn runs the part stays plain text, since a compaction is refused then.
- Subscription quota left in the 5-hour and weekly windows, as remaining percent like mini-system-monitor-rs, each with a 10-cell gauge: green, yellow at 25% or less, red at 10% or less. The terminal draws the gauge in block characters (eighths of a cell); the desktop Code tab draws it as a rounded SVG bar. Two sources, the newer reading shown:
  - this session's own API responses (`session.measure`'s `rateLimits`), shown the moment a window moves a whole point;
  - the account usage endpoint `https://api.anthropic.com/api/oauth/usage` (the one mini-system-monitor-rs reads), so use from other sessions shows too. It is fetched through `$.http.fetch` with the session's own credential (`$.session.authorize()`; the token never reaches the mod), at session start, when a turn ends (at most once a minute) and otherwise every 3 minutes; a failure or 429 doubles the wait up to 15 minutes. The result, the last fetch time and the backoff are kept in the plugin's `$.store`, which every session reads, so open sessions share one fetch. The endpoint is undocumented and may change or stop working.
  Nothing shows until one of them has a reading, nor off a subscription (an API key).
- Git state of the session's folder: branch, uncommitted files, unpushed commits (↑), commits behind (↓). A branch with no upstream shows `GitHub未公開`, or `upstreamなし` when the repo's remotes are all non-GitHub. It is read at session start, on each prompt, after Bash/Edit/Write tool calls (at most once per 2 s) and when a turn ends. In a folder that is not a Git repository, or on a host that cannot run commands (`$.process` is CLI only), the line shows the context part alone.
- When there are uncommitted files, the count is a button: pressing it submits `未コミットの変更をコミットして` as your prompt, so the session starts the commit (queued until the current turn ends).
- `Hide` collapses the line to a small `▸ ctx/git` button; press it to bring the line back.

Claude Code only; Codex has no mods. The source of truth is this directory; install it through the `suzuki-local-plugins` marketplace (`~/.claude/local-plugins/bin/claude-plugin-refresh`).

## Check

```bash
claude plugin validate ~/plugins/context-git-band
```
