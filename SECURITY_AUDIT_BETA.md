# Thetanuts SDK Beta — Security Audit Report

**Status:** IN PROGRESS — workstreams active, findings not yet consolidated.
**Branch under audit:** `beta` (HEAD `ba10591` at engagement start).
**Audit firm:** Trail of Bits (internal engagement model).
**Audit lead-of-record:** Chief Security Officer.
**Engagement issue:** TNU-2.
**Engagement plan:** see TNU-2 `plan` document.

---

## 0. About this document

This file is the **single deliverable** of the Thetanuts SDK beta security audit. It is updated additively as workstreams complete and findings clear the False-Positive gate. Until each workstream marks `done`, the corresponding section here remains a placeholder.

Every finding included below carries: title, severity, file:line citation, reproduction, and remediation. Speculative findings are rejected before consolidation — they do not appear here.

## 1. Scope

| Surface | Path | Workstream | Lead |
|---|---|---|---|
| CollarModule | `src/modules/collar.ts` | W1 | Blockchain Security Lead |
| LoanModule | `src/modules/loan.ts` | W1 | Blockchain Security Lead |
| WheelVaultModule | `src/modules/wheelVault.ts` | W1 | Blockchain Security Lead |
| OptionFactory | `src/modules/optionFactory.ts` | W1 | Blockchain Security Lead |
| Option | `src/modules/option.ts` | W1 | Blockchain Security Lead |
| StrategyVault | `src/modules/strategyVault.ts` | W1 | Blockchain Security Lead |
| SDK public boundary | `src/index.ts`, `src/modules/*.ts`, `src/modules/utils.ts` | W2 | Audit Lead |
| Tx construction & signing | `erc20.ts`, `optionBook.ts`, `optionFactory.ts`, `wheelVault.ts`, `loan.ts`, `collar.ts`, `rfqKeyManager.ts`, `mmPricing.ts`, `cli/src/rfqKeyStorage.ts` | W3 | Audit Lead |
| Supply chain | `package.json`, both lockfiles, `node_modules`, build scripts | W4 | Audit Lead (Supply Chain Auditor) |
| MCP server | `mcp-server/src/` | W5 | Audit Lead |
| CLI | `cli/src/` | W5 | Audit Lead |
| ABI parity & invariants | `src/abis/*.ts` vs canonical JSONs; runtime invariants | W6 | Verification Lead |

Out of scope: on-chain contract code; reverse-engineering of compiled binaries.

## 2. Severity classification

| Severity | Definition |
|---|---|
| Critical | Direct loss of user funds or full key compromise from realistic input/path |
| High | Loss of funds requiring specific but reachable condition, or full integrity break of a core invariant |
| Medium | Partial DoS, recoverable lockup, missing validation that compounds with another bug |
| Low | Defense-in-depth issue, hygiene, ambiguous behavior |
| Informational | Documentation, dead code, optimization hints |

## 3. Summary of findings

> _This table is populated once W1–W6 close. Counts below are placeholders until consolidation completes._

| Severity | Count |
|---|---|
| Critical | _pending_ |
| High | _pending_ |
| Medium | _pending_ |
| Low | _pending_ |
| Informational | _pending_ |

## 4. Findings

> _This section is populated once W1–W6 close and the False-Positive Analyst signs off on each finding. Each entry will follow the template below._

### Template

> **Finding ID:** TNU-AUDIT-`NNNN`
> **Title:** `<short, specific>`
> **Severity:** `Critical | High | Medium | Low | Informational`
> **File:** `<path>:<line>`
> **Workstream:** `W1 | W2 | W3 | W4 | W5 | W6`
>
> **Description.** `<what is wrong, why it matters>`
>
> **Reproduction.** `<exact command, test name, or step-by-step that produces the bug>`
>
> **Remediation.** `<concrete diff or change; landed in commit <sha> when fixed>`
>
> **Status.** `Open | Fixed (commit <sha>) | Won't fix (rationale)`

## 5. Workstream status

| ID | Workstream | Lead | Issue | Status |
|---|---|---|---|---|
| W1 | Option/vault modules | Blockchain Security Lead | TNU-3 | in_progress |
| W2 | SDK public boundary | Audit Lead | TNU-4 | in_progress |
| W3 | Tx construction & signing | Audit Lead | TNU-5 | in_progress |
| W4 | Supply chain | Audit Lead | TNU-6 | in_progress |
| W5 | MCP server & CLI | Audit Lead | TNU-7 | in_progress |
| W6 | Property-based & spec compliance | Verification Lead | TNU-8 | in_progress |
| W7 | Consolidation + fix routing | CSO | TNU-9 | blocked on W1–W6 |

## 6. Fix routing (when applicable)

Critical/High fixes route through **CEO 3 (Lead Reviewer chain)** — Code Reviewer + Security Reviewer must both approve before merge. CI Integration Engineer ensures each fix has a regression test (preferring property tests from W6).

All commits and pushes target `origin beta` only. Never `upstream`. Never `main`, `feat/collar-module`, `loan`, or any other branch. No force-push, no history rewrites.

---

_Last updated: 2026-05-23 (engagement open)._
