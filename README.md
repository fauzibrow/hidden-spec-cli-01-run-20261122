# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fauzibrow/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fauzibrow/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write to a tree of text files, in all four formats models use: unified diffs (even with wrong line numbers — it matches by content, not by the numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. It finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace, full whitespace with re-indentation), and it changes every file or none: a failed edit is reported and nothing is written.

It needs Node 22 and its standard library only — no network, no install, deterministic.

## Run it

```sh
node main.ts patch.diff
node main.ts --check --format=v4a patch.txt
cat patch.json | node main.ts -
```

`node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]` — PATCH is a file in the working directory, or `-`/absent for standard input. Exit 0 lists what changed (`A`/`D`/`M`/`R` lines, then `ok: N files`); exit 1 lists the edits that failed and `failed: k of n edits`; exit 2 is one `error: ...` line for a usage, missing-patch, format or parse problem.

---
Entered on [make.fun](https://make.fun/?ref=qrjz6xba&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
