# Contributing to SAM

Thanks for helping. SAM is small on purpose: one SQLite file, zero npm dependencies, no model calls in the hot path. Please keep it that way.

## Setup

Requirements: Node.js **22.16+ (22.x) or 24+** (SAM uses the built-in `node:sqlite` with FTS5, which Node 22.13–22.15 and 23.x lack). Nothing else.

```bash
git clone https://github.com/GITHUB_OWNER/super-agent-memory.git
cd super-agent-memory
npm test          # unit + integration tests (node:test)
npm run bench     # token benchmark (must stay at 20/20)
npm run bench:retrieval  # retrieval-quality benchmark; tune only on the tuning half (bench/retrieval/README.md)
npm run e2e       # install into a temp home, run every installed hook command through sh
npm link          # optional: put your checkout's `sam` on PATH
```

There is no `npm install` step: the package has no dependencies, and new runtime dependencies will not be accepted without a strong reason discussed in an issue first. Dev-only tooling should also be avoided where `node:` built-ins can do the job.

## Keep your real setup safe while developing

SAM writes to two places. Point both at a scratch directory whenever you run a development build by hand:

| Variable | Default | What it moves |
|---|---|---|
| `SAM_HOME` | `~/.sam` | the database (`sam.db`) and `config.json` |
| `SAM_INSTALL_HOME` | your home directory | where `sam install` / `uninstall` edit agent configs |

```bash
export SAM_HOME=$(mktemp -d) SAM_INSTALL_HOME=$(mktemp -d)
node bin/sam.js install --all --dry-run
```

While `SAM_INSTALL_HOME` (or `SAM_TEST=1`) is set, the installer never runs the real `claude` CLI, never scans your PATH for agents, and ignores `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME` unless they point inside `SAM_INSTALL_HOME`. The test suite sets all of these itself. `SAM_CLAUDE_VERSION=2.1.140` makes the installer act as if that Claude Code version were installed (exec-form hooks).

## Tests

- Tests live in `test/*.test.js` and use `node:test` and `node:assert/strict` only.
- Every bug fix comes with a test that fails before the fix.
- Tests must not depend on timing where it can be avoided. If a performance guard is needed, keep a wide margin and say why in the assertion message.
- POSIX-only assertions (for example `sh -c`, `printf`) must be skipped on Windows with `{ skip: process.platform === 'win32' }`, and a Windows equivalent added where it matters (quoting is the classic case). Windows command forms are also tested on every OS by passing `plat: 'win32'` to the builders in `src/platform.js` / `src/install.js`.
- Put new tests in a new file per area (`test/platform.test.js`, `test/cli.test.js`, …); each file runs in its own process with its own temp `SAM_HOME`.
- Coverage: `node --test --experimental-test-coverage test/*.test.js`.

CI runs the suite on Ubuntu, macOS and Windows with Node 22.16 (the declared floor) and 24, checks that Node 22.15 gets the clear version error, runs the benchmark, and smoke-tests the packed tarball after a global install, including `sam install --all` and the hook self-test through each host's real shell (bash, PowerShell, cmd on Windows).

## Code style

- ES modules, 2-space indentation, single quotes, semicolons. Match the surrounding code.
- Public functions get a JSDoc comment saying what they return and what they never do (for example "never throws", "never writes outside `SAM_HOME`").
- Tunable numbers belong in `src/config.js` (and in the README configuration table), not inline.
- Hooks must never break the host: catch errors, exit 0, return `{}`.
- Anything that reaches an agent's context counts tokens: measure it with `sam tokens` or `tokens()` and keep budgets intact.

## Adding a host (agent)

1. Map the host's event names in `normalize()` and its reply shape in `reply()` in `src/hooks.js`.
2. Add an installer function in `src/install.js` that only touches entries it owns (see `isOurs`) and that `uninstall` fully reverses.
3. Add hook-payload and installer tests with real payload samples from the host's docs or source.
4. Document it in the README integrations table (English and Turkish).

## Documentation

- `README.md` and `README.tr.md` must stay in parity. If you change one, change the other or say in the PR that a translation is needed.
- Numbers in the docs (benchmark, latency, test count) must come from a command anyone can run. Update them when they change.
- User-facing changes go under `## [Unreleased]` in `CHANGELOG.md`.

## Pull requests

- One topic per PR. Explain the problem first, then the change.
- Checklist: tests pass locally, new behavior is tested, docs and CHANGELOG updated, no new dependencies, no secrets in fixtures (use fake keys that match the format).
- Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a PR or issue.

By contributing you agree that your contribution is licensed under the MIT License of this repository.
