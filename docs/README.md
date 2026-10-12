# Documentation index

All docs are in English; the plain-language guides also have a Portuguese version (PT). Decisions and the history of
the rebuild on Tempo are in `migration/` (`decisions.md` lists every decision D1-D20 and deviation X1-X34).

## Guides

| Doc | What it covers |
|---|---|
| [concepts-guide.md](concepts-guide.md) | Plain-language tour of the whole system: wallets, licenses, guarantees, the MCP connector ([PT](guia-conceitos.md)) |
| [creator-guide.md](creator-guide.md) | How creators build, upload and publish a Solver, and how admins review it ([PT](criador-solvers.md)) |
| [../PACKAGE_SPEC.md](../PACKAGE_SPEC.md) | The Solver package format: manifest, steps, knowledge base, templates, evals ([PT](../PACKAGE_SPEC.pt-BR.md)) |

## Design

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Components, data flow, fee sponsorship (relay), nonce lanes, indexer, auth, contracts, roles, upgrades |
| [economics.md](economics.md) | Units, minimum price, fee split, deferred payouts, stake; network fees never deducted |
| [royalties.md](royalties.md) | The on-chain royalty paid on every license transfer |
| [license-cap.md](license-cap.md) | Per-Solver license cap: enforced on-chain, can only be raised, never freed by transfers |
| [payments.md](payments.md) | Payment providers (wallet, Pix, agent-pay), charge lifecycle, ledger, reconcile |
| [payments-open-questions.md](payments-open-questions.md) | Business and accounting questions the owner still has to answer (questions only) |
| [agent-login.md](agent-login.md) | Sign-in with SIWE: web, MCP clients (OAuth DCR + PKCE) and agents with their own key |
| [agent-payments.md](agent-payments.md) | AI agents buying licenses over HTTP 402 with the Machine Payments Protocol |

## Operations

| Doc | What it covers |
|---|---|
| [deploy-runbook.md](deploy-runbook.md) | Contract deployment, roles, verification, keys, server and web deployment, first publication |
| [treasury.md](treasury.md) | PLATFORM float, RELAY fee key, cold treasury, alerts, top-ups, ledger export |
| [qa.md](qa.md) | Local stack on `anvil --tempo`, test commands, e2e scripts, Moderato runs |
| [ci-notes.md](ci-notes.md) | What CI runs and the hardening still to do |

## Migration record

| Doc | What it covers |
|---|---|
| [migration/progress.md](migration/progress.md) | Where the rebuild stands and how to resume |
| [migration/decisions.md](migration/decisions.md) | Decisions, deviations and what the owner still owes |
| [migration/00-inventory.md](migration/00-inventory.md) | File-level inventory of what was kept, ported or dropped |
| `migration/phase-1.md` … `phase-6.md` | One note per phase: what was built, measured and reviewed |
| [migration/phase-7.md](migration/phase-7.md) | Phase 7: docs, infra (PM2, nginx, deploy scripts), CI, the upgrade procedure and the sponsored admin steps |
| [migration/phase-8.md](migration/phase-8.md) | Phase 8: purge and final verification (end-to-end runs on anvil, locally and on Moderato) |
