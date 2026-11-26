# omp-session-context

When you run several coding agents at once, switching back into one costs a minute of "where was I?". This shows the answer on screen.

Two parts:

- **`extension/`: an [OMP](https://github.com/can1357/oh-my-pi) extension.** It works on its own, no Herdr needed.
  - The PR, issue and ticket links a session touches (GitHub, GitLab, Linear) appear in a widget above the editor and on the status line.
  - `/links` pins and unpins them; `/links off|on` hides or shows the widget.
- **`herdr-mod/`: a Herdr Desktop mod.** A side panel that follows the focused terminal and shows what its OMP session is about: the original request, todo progress, what the agent is waiting for, links, model, cost, corrections, tool errors and the last test run. Needs Herdr Desktop (`herdr-app`).

The panel also has *Works* / *Doesn't work* buttons. Each click records a verdict, so over time you can compare which models and setups actually did the job.

Status: early. Built around one person's setup and shared as is.

## Install

```bash
./install.sh extension          # links extension/ into ~/.omp/agent/extensions/session-context
./install.sh mod [host]         # copies herdr-mod/ to ~/.config/herdr-app/mods/session-context (on host, over ssh, if given)
```

Without the mod you only get the links widget. With it, the extension also writes a summary per Herdr terminal (`HC_TERMINAL_ID`), and the mod reads it.

Add the block to your Herdr Desktop layout, inside the container you want it in:

```json
{
  "id": "session-context",
  "type": "block",
  "content": { "mod": "session-context" },
  "size": { "px": 360 },
  "min": 280,
  "max": 700
}
```

Then bind a key in `keys.json` to toggle it, for example `"f6": "layout.toggle:session-context"`. The palette entry "Session context" toggles it too.

If your agents run on another machine, install the extension there. The mod reads the files over Herdr's remote `readTextFile`/`exec`, so the machine must be one Herdr Desktop reaches.

## Data

Everything goes to `$XDG_STATE_HOME/omp-session-context/` (default `~/.local/state/omp-session-context/`):

- `<HC_TERMINAL_ID>.json`: the live summary of the terminal's session. Written atomically, at most once a second. Files older than 7 days are removed when the extension starts.
- `sessions.jsonl`: one line per session when it ends, plus one per verdict. The latest line for a `sessionId` wins.
- `verdicts/<sessionId>`: the current verdict.

Nested OMP sessions (subagents, `OMPCODE=1`) never write the terminal's file or an evaluation line.

One record per session:

```bash
jq -s 'group_by(.sessionId) | map(last) | map({model, finished, corrections, toolErrors, tests: .tests.status, verdict})' \
  ~/.local/state/omp-session-context/sessions.jsonl
```

How a record is judged:

- **finished**: every todo task done, or, without a todo, the last turn wasn't aborted.
- **corrections**: user messages that arrive while the todo has open tasks, plus every user interrupt. A simple heuristic.
- **tests**: the last `bash` call whose command starts with a known test runner (`npm|pnpm|yarn|bun test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `just|make test`) and whether it failed.

## Sessions started by other agents

When an agent starts another one, the new session's panel shows *Started by* with the parent session's title. Click it to jump back to the parent.

The parent comes from herdr-core: a terminal started with `hc run` from another terminal has it as its `parent`. Launchers that use `hc run --no-parent` (to keep the new terminal independent) can still name it with a label, `--label session-context.parent=$HC_TERMINAL_ID`. Both terminals must be on the same machine for the parent's title to show; otherwise you only see its terminal id.

## Options

- `SESSION_CONTEXT_REF`: a regular expression for your own references (for example `\bT-\d+\b` for ticket ids). Matches are listed in the panel under *Tasks*, most recent first. Unset by default.

## Tests

```bash
bun test extension herdr-mod
```

## End-to-end check

`e2e/run.sh` starts a real OMP agent in an unfocused Herdr tab on a throwaway repo, waits for it to finish and asserts what the extension wrote. It needs Herdr Desktop running, `hc`, `jq` and a working OMP model.

```bash
HERDR_SSH=my-desktop-host ./e2e/run.sh            # HERDR_SSH only if Herdr Desktop runs on another machine
SHOT=panel.png ./e2e/run.sh                       # also saves a screenshot of the window with the panel showing that session
```

Set `E2E_REPO=owner/name` (a throwaway repo you can push to) and the agent also opens a pull request there, so the panel's *Links* section has something to show. The PR is closed at the end.
