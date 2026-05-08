# Contributing to `@thetanuts-finance/thetanuts-client`

Thanks for considering a contribution. This document is the practical guide for getting set up, making changes, and shipping them.

## TL;DR

```bash
git clone https://github.com/Thetanuts-Finance/thetanuts-sdk.git
cd thetanuts-sdk
npm install
npm run typecheck    # must pass before any commit
npm run lint         # must pass
npm run build        # ESM + CJS + types build clean
npm test             # live mainnet integration suite (Base mainnet)
```

If those four green-light, you're ready to open a PR.

## Project layout

```
src/
  abis/         Inline TypeScript ABIs for every Thetanuts contract.
                Source of truth = the canonical contract artifacts at
                /Users/.../thetaverse/abis/*.json (not in this repo).
                Don't paraphrase — lift verbatim.
  chains/       Chain registry. addresses, tokens, price feeds,
                implementation lookup.
  client/       ThetanutsClient construction + wiring.
  modules/      One file per `client.<name>` surface (optionBook,
                optionFactory, ranger, loan, events, …).
  types/        Shared TypeScript types and error classes.
  utils/        Pure helpers (decimal conversion, error mapping,
                validation, RFQ math).
docs/           GitBook-published user-facing documentation.
                docs/SUMMARY.md is the sidebar.
scripts/        Live mainnet integration tests.
mcp-server/     Optional MCP server wrapping the SDK.
```

## Development workflow

### 1. Branching

Branch off `main`. Use a descriptive branch name (`fix/r12-codex-findings`, `docs/rfq-referrals`, `feat/wheel-vault-multi-chain`). Tagging convention: `feat/`, `fix/`, `docs/`, `chore/`, `release/`.

### 2. The four required gates

Every PR must pass these locally before review. CI re-runs them.

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src --ext .ts
npm run build        # tsup → ESM + CJS + types
npm test             # scripts/run-mainnet-tests.ts (live Base mainnet)
```

`npm test` hits live mainnet RPC and the indexer API. If you're offline or those are down, document that in the PR.

The default RPC is the public `https://mainnet.base.org`, which throttles bursts of read calls. The runner has retry logic to handle this, but if you have a paid endpoint (Alchemy, QuickNode, Infura) you can skip the flake entirely:

```bash
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY npm test
```

### 3. Commit messages

Use conventional-commit prefixes: `feat(modules): …`, `fix(abi): …`, `docs: …`, `chore: …`, `release: …`. Multi-line bodies are encouraged for non-trivial changes — explain *why*, not just *what*.

**No `Co-Authored-By` trailers** unless a real human collaborator should be credited. The maintainer prefers clean attribution.

### 4. Pull requests

PRs target `main`. Title matches the leading commit subject. Body should include:

- **Summary** — what changed and why
- **Test plan** — checklist of what you verified
- **Breaking changes** if any, with before/after snippets

For non-trivial changes, run a code-review pass with `/codex challenge` (see [Code review process](#code-review-process) below) before opening the PR — this is what caught the 22 issues in the v0.2.0 → v0.2.1 cycle.

## Working with ABIs

The SDK ships hand-maintained inline ABIs as TypeScript constants (`src/abis/*.ts`). When the protocol contracts change:

1. Get the latest canonical ABI JSONs from the contracts repo (out of band — not vendored here).
2. Diff each function/event signature against the existing inline ABI. Use `jq` to extract specific entries:

   ```bash
   jq '.[] | select(.name == "split")' /path/to/canonical/BaseOption.json
   ```

3. Update the inline TS ABI to match — same field order, same `internalType`, same `stateMutability`, same indexed flags on events.
4. If a function/event signature changed in a way that breaks consumers (parameter rename, new field, changed return shape), update the typed wrapper in `src/modules/<module>.ts` and bump the breaking-change list in `CHANGELOG.md` and `docs/resources/migration-guide.md`.

**Never include admin-only contract functions in the SDK ABIs** unless we explicitly want them on the user-facing surface. `setBaseSplitFee`, `withdrawFees` (factory-level), `transferOwnership`, etc. revert for non-owner callers and just confuse the dev.

## Code review process

Every non-trivial PR goes through two review passes:

### Pass 1: codex review

Run `/codex review` (if you use Claude Code with the gstack toolkit) or invoke `codex review --base main` directly. Codex flags issues by priority `[P1]` / `[P2]`. Pass gate if no `[P1]`.

### Pass 2: codex challenge (adversarial)

For changes that touch contract ABIs, payable functions, or zero-address logic, run `/codex challenge` after the review pass. Codex actively tries to break the code — finds new edge cases. The v0.2.1 release fixed 22 issues across three iterative passes; this is what that workflow produces.

### Cross-model heuristic

If both Claude and Codex flag the same line, fix it. If only one flags it, treat it as an opinion — your judgment.

## Releases

Release notes live in three places. Keep them in sync; they have different audiences.

| Source | Audience | Format |
|---|---|---|
| `CHANGELOG.md` (repo root) | npm users, ships in tarball | Terse per-version log |
| GitHub Releases | People browsing the repo, `gh release view`, dependabot | Per-version body, copy-paste from `CHANGELOG.md` |
| `docs/resources/changelog.md` (GitBook) | Devs reading docs.thetanuts.finance/sdk | User-facing highlights for the latest few releases |

The release flow:

1. **Code PR** (e.g. `release: v0.2.1 — Base_r12 cutover + codex-found fixes`)
   - Bumps `package.json` version
   - Adds `CHANGELOG.md` entry at the top
   - Adds matching summary to `docs/resources/changelog.md` (latest 3-5 releases shown there; older ones are listed terse)
   - All four gates green before merge

2. **npm publish** from `main` after merge:

   ```bash
   git checkout main && git pull --ff-only
   npm whoami                              # confirm publish rights
   npm pack --dry-run                      # eyeball tarball contents
   npm publish --dry-run --access public   # final preflight
   npm publish --access public             # go live (requires 2FA OTP)
   git tag -a v<version> -m "v<version> — <subject>"
   git push upstream v<version>
   ```

3. **GitHub Release** after the tag is pushed:

   ```bash
   gh release create v<version> \
     --title "v<version> — <subject>" \
     --notes-file - <<'EOF'
   <paste the corresponding section from CHANGELOG.md>
   EOF
   ```

`prepublishOnly` re-runs the build automatically. Don't manually edit `dist/` — it gets clobbered.

### MCP server releases (separate cadence)

The MCP server in `mcp-server/` ships as `@thetanuts-finance/mcp` on its own version cadence — tracks its own surface, not the SDK's. Tags use the prefix `mcp-v*` so they don't collide with SDK tags `v*` on the same commit.

```bash
git checkout main && git pull --ff-only
cd mcp-server

npm whoami                                  # confirm logged in
npm org ls thetanuts-finance                # confirm org membership

npm publish --dry-run --access public       # preflight (runs prepublishOnly which swaps the SDK dep)
npm publish --access public                 # go live (2FA OTP)

# postpublish auto-restores the file:.. SDK dep — verify the working tree is clean:
git status                                  # mcp-server/package.json should be unchanged

cd ..
git tag -a mcp-v<version> -m "MCP v<version> — <subject>"
git push upstream mcp-v<version>

gh release create mcp-v<version> \
  --title "MCP v<version> — <subject>" \
  --notes "<release notes>"
```

The `prepublishOnly` script swaps `@thetanuts-finance/thetanuts-client` from `file:..` (workspace link) to `^<sdkVersion>` (npm range, read from the root `package.json`'s version field). The `postpublish` script restores `file:..` so local dev keeps using the workspace SDK. Both swaps are idempotent.

If the SDK was just published in the same session, bump `mcp-server/package.json`'s SDK dep range mentally (the swap script reads the latest root version automatically; you only need to verify root `package.json` reflects the SDK version you actually want the MCP to depend on).

## Reporting bugs

Open a GitHub issue using the bug-report template. Include:

- SDK version (`npm ls @thetanuts-finance/thetanuts-client`)
- Node version
- Chain ID
- Minimal reproduction (the smallest snippet that triggers the bug)
- What you expected vs what happened
- Stack trace if any

For security-sensitive issues, see [SECURITY.md](./SECURITY.md) — do not open a public issue.

## Style notes

- Default to writing no comments. Only add one when the *why* is non-obvious.
- Don't add error handling for scenarios that can't happen. Trust internal code.
- Don't reach for new abstractions when three similar lines work.
- TypeScript over JavaScript. No `any` unless it's load-bearing — narrow with type guards.
- Keep modules small. If `src/modules/foo.ts` crosses ~600 lines, that's a signal it's doing too much.

## Getting help

- **GitBook docs:** [docs.thetanuts.finance/sdk](https://docs.thetanuts.finance/sdk)
- **GitHub issues:** [Thetanuts-Finance/thetanuts-sdk/issues](https://github.com/Thetanuts-Finance/thetanuts-sdk/issues)
- **Discussion / questions:** open an issue tagged `question`
