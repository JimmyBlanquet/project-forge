# Contributing to Project-Forge

Thanks for your interest in contributing! Project-Forge is an opinionated SaaS factory and we value contributions that align with its principles: **production-readiness, autonomous loops, and SDLC industrialization**.

## Ground rules

1. **Read the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** before participating
2. **Open an issue first** for non-trivial changes — let's align on scope before you write code
3. **One concern per PR** — small, focused changes get reviewed faster
4. **Tests pass** (`bash tests/forge-eval.sh` must remain green)

## Quick start for contributors

```bash
# Fork + clone
git clone https://github.com/YOUR-USERNAME/Project-Forge.git
cd Project-Forge

# Run the test harness to make sure your environment is sane
bash tests/forge-eval.sh

# Try bootstrap on a temp project
./tools/bootstrap test-project --dir /tmp --starter supabase-stripe
```

## Development workflow

### 1. Pick or open an issue
- Look for `good first issue` or `help wanted` labels (GitHub default labels)
- For new features, open an issue with the use case before coding

### 2. Branch and code
```bash
git checkout -b feat/your-feature-name
# ... make your changes ...
```

### 3. Test
```bash
# Project-Forge harness
bash tests/forge-eval.sh

# If you touched tools/bootstrap, also test a real bootstrap:
./tools/bootstrap test-bootstrap --dir /tmp --starter saas
```

### 4. Commit
We use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat(scope): description
fix(scope): description
chore(scope): description
docs(scope): description
```

Examples:
```
feat(bootstrap): add --skip-install flag for offline scenarios
fix(ralph): correct PRD parsing when story has no acceptance criteria
docs(adr): add ADR-009 on extension packaging strategy
```

### 5. Pull request
- Reference the related issue (`Closes #42`)
- Describe the **why** more than the **what**
- Include test plan in the PR description
- Be patient — reviews are best-effort

## What we welcome

- 🐛 **Bug fixes** with reproduction steps
- 🎯 **New skills** (in `skills/` or `extensions/`) that fit the SDLC pipeline
- 📚 **Documentation improvements** (ADRs, README, guides)
- 🔧 **Starter improvements** that benefit all generated projects
- 🧪 **Test coverage** for `tests/forge-eval.sh`
- 🌍 **Internationalization** (currently FR/EN mixed; consistency welcome)

## What we are cautious about

- Breaking changes to `tools/bootstrap` API (require ADR + migration guide)
- New starters (we consolidated to keep maintenance focused — make a strong case)
- Heavy dependencies in the framework itself (starters are different — they can include what they need)

## Project structure

See the [README.md Architecture section](README.md#architecture).

Key directories:
- `tools/` — CLI tools (bootstrap, ralph, migrate-to-speckit)
- `starters/` — project templates copied into new projects
- `skills/` — Project-Forge skills (loaded into child projects)
- `extensions/` — spec-kit extensions packaged as installable units
- `tests/forge-eval.sh` — the test harness (must remain green)

## Architecture Decision Records

Significant changes should be documented as ADRs in `docs/adr/`. Use the existing ADRs as templates. Number sequentially.

## Security: avoiding sensitive references

Project-Forge is intentionally **harness-pure**: zero hardcoded credentials, zero private endpoints, zero organization-specific configs. Anything that looks like a secret, a private IP, or an internal endpoint must live in environment variables or be configured at deployment time.

A CI check enforces this on every PR and push to main:

```bash
# Run locally before committing
bash scripts/check-no-internal-refs.sh
```

The scanner detects:
- API keys in clear (OpenAI `sk-*`, Anthropic `sk-ant-*`, Google `AIza*`, AWS `AKIA*`, GitHub `ghp_*`, Slack `xoxb-*`)
- Private IPs (RFC 1918 + Tailscale CGNAT 100.64-127.x.x.x)
- Credentials inline in URLs (`https://` followed by `user:pass@`)
- Tracked `.env` files (should be gitignored, except `.env.example`)
- Custom project patterns from `.security-patterns` (one regex per line)

If you intentionally need to commit something the scanner flags (rare — usually example/doc):
- Add the path glob to `.security-allowlist` (one per line)
- Or use `.env.example` instead of `.env` for templates

The scanner has 3 modes:
```bash
bash scripts/check-no-internal-refs.sh           # all tracked files
bash scripts/check-no-internal-refs.sh --staged  # only git-staged files (use as pre-commit)
bash scripts/check-no-internal-refs.sh --since main  # only files changed since main
```

To wire as a local pre-commit hook (optional):
```bash
echo '#!/bin/bash
exec bash scripts/check-no-internal-refs.sh --staged' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Releasing

Releases are tagged on `main` after manual smoke testing. Currently maintained by repo owner — community release proposals welcome via issues.

## Questions?

Open a [Discussion](https://github.com/JimmyBlanquet/project-forge/discussions) or an issue with the `question` label.
