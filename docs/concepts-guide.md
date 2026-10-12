# The Solvers guide for people who have never seen a blockchain

English | [Português](guia-conceitos.md)

State as of 2026-10-11. Everything runs on **Moderato**, Tempo's test network, with **test money** (a stablecoin handed out
by a public faucet). Mainnet (real money) is planned, not live: it waits for the owner's decisions listed in
`docs/migration/decisions.md` (the payment token among them). Anything that is a **prototype or does not exist yet** is
marked "(prototype)" or "(planned)".

Deeper reading: [architecture](architecture.md), [economics](economics.md), [royalties](royalties.md),
[payments](payments.md), [agent payments](agent-payments.md), [agent login](agent-login.md),
[license cap](license-cap.md), [creator guide](creator-guide.md).

---

## 1. The whole story in 6 lines

1. A **creator** builds a "specialist" (a Solver): a folder of text with steps, knowledge and templates. It is not a program, it is a **recipe**.
2. The **server** keeps the recipe and hands it **one step at a time** to the buyer's Claude/ChatGPT (through a "connector" called MCP). Anyone holding the whole recipe in one file could copy it for free, which is why it stays locked on the server.
3. The **buyer** pays in a **dollar stablecoin** and receives a **license**: a unique digital item (an NFT) that lands in their wallet. The platform pays the network fee.
4. The server looks at the wallet: "has a license? then unlock it."
5. A **guarantee** means the money sits in a vault until the work passes the tests agreed beforehand.
6. **AI agents with no human** buy too: they pay over HTTP (the Machine Payments Protocol, MPP) or straight from their own wallet, and the license lands in their wallet.

---

## 2. Blockchain concepts

| Term | In plain words | In Solvers |
|---|---|---|
| **Blockchain** | A giant notebook that **many computers keep in sync**. You only write at the end, and nobody can erase what has already been written. | The notebook is **Tempo**, a payments-focused chain compatible with Ethereum tools (EVM). Test network **Moderato** (chain id 42431) today; mainnet (4217) later. |
| **Why use it** | Nobody has to **take our word for it**: anyone can check the notebook to see who bought, how much the creator received, what the rating is. | Licenses, reviews, guarantees, stake, supply cap, transfer royalty and reputation. |
| **Wallet** | Your **address** in the notebook (like an account number) plus a **secret key** only you hold (like a pen password). | Email login (Privy) **creates an embedded wallet** (an ordinary Ethereum-style account); the user never has to see it. On test networks a "dev wallet" (a test key kept in the browser) also exists. |
| **Private key / signature** | Signing = proving "it was me" without revealing the password. Without a signature nobody can touch your things. | Buying, reviewing, transferring, opening a dispute: the user signs. Signing in is also a signature (**SIWE**, Sign-In With Ethereum, EIP-4361) whose text says it authorizes no payment and costs nothing. |
| **Transaction** | A **sentence written in the notebook**: "Ana pays 10 to Beto". | Every purchase is a transaction: the server prepares the calls, the user's wallet signs. |
| **Batched transaction** | Several sentences written **as one**: all of them happen or none does. | Tempo transactions carry a list of calls. A purchase is `[approve the price, purchase]` in one atomic transaction: if the purchase fails, the approval is undone too. |
| **Network fee (gas)** | Each sentence costs a tiny fee. Tempo has **no native coin**: the fee is paid in a stablecoin. | **The platform always pays** through its **relay** (a "fee payer" that co-signs your transaction). Users and agents never need anything for fees. The heaviest user action (a guarantee with 5 milestones) costs a few cents at the fee cap. |
| **Stablecoin (TIP-20)** | A digital token worth 1 US dollar. TIP-20 is Tempo's token standard (compatible with ERC-20), always with **6 decimals**. | The price of everything. On Moderato it is the test **pathUSD** from the public faucet. The mainnet token is still the owner's decision. |
| **Testnet / mainnet** | Testnet = training ground with test money. Mainnet = the real game. | We are on Moderato (testnet). |
| **Smart contract** | A **robot judge that lives in the notebook**: it follows rules written in code, and nobody can bribe it. | Six contracts in `contracts/src` (Solidity): Registry (rules, Solvers, cap), License (the NFTs and the royalty), Credits, Reviews, Escrow (guarantees), Staking. |
| **Upgradeable contract** | The robot judge can be swapped for a new version **at the same address**, keeping its drawers. | All six are upgradeable (UUPS). Only the cold admin can upgrade, and the stored data is **append-only**: new fields are added at the end, existing ones never change shape. |
| **NFT (ERC-721)** | A **unique digital item with a registered owner** in the notebook. | The **license**. Whoever owns it has access. |
| **Hash** | A **fingerprint** of a file: change one letter and everything changes. | `versionHash` (package), `contentHash` (review text), `criteriaHash` (guarantee tests), `deliverableHash` (deliverable). Only the fingerprint goes on-chain; the text stays off-chain. |
| **Event + indexer** | The contract "shouts" what happened; the **indexer** reads the shouts and copies them into our database (fast to query). | The server asks the chain for new events every second (`eth_getLogs`), one block behind the tip; there is no webhook. The database is a **mirror**; the truth is the chain. |
| **Escrow** | A **piggy bank with two locks**: the money leaves the buyer, stays locked, and is only released when the rule says so (to the creator or back). | The **guarantee** (section 8). The money is held by the `SolversEscrow` contract; not even the platform can take it out outside the rules. |
| **Stake** | A creator's **good-faith deposit**: if they cheat, they can lose it. | `minStake` is **0 on Moderato**, so it does not protect anyone yet. |
| **Held payout + claim** | If a wallet has a rule that refuses incoming money, the payment would bounce. | The contract **keeps** that amount for the recipient (a "held payout") and the sale still goes through; the recipient takes it later with **Claim**. |
| **Merkle root** | A **single fingerprint that summarizes a whole list** of receipts. | A batch of verified uses, every 10 min. |
| **Basis points (bps)** | A percentage in hundredths: 1000 bps = 10%. | Fee and royalty. |

**What is NOT on the blockchain** (and you should be able to say so clearly): the Solver's **content** (steps, knowledge), the user's **memories**, **sessions**, the **text** of reviews (only the fingerprint), the catalog texts and prices in local currency (Pix). What **is** there: license owner, price, sales, ratings, credits, guarantee, stake, version (hash), eval score per version, supply cap and reputation.
**Honest limit:** the license belongs to the user, but it is **our server** that unlocks the content by reading the wallet. If the server disappeared, the user would still own the NFT but would have no way to run the Solver.

---

## 3. Who is who

| Who | What they do |
|---|---|
| **Creator** | Writes the package, sets the price and their royalty share, earns from each sale and each transfer, can cap the number of licenses. |
| **Buyer (human)** | Signs in by email (or with a wallet), pays, connects Claude/ChatGPT to the connector. |
| **Autonomous agent** | An AI with no human, holding its own key and stablecoin. Buys over MPP or directly from its wallet. |
| **Server (platform)** | Delivers steps, knowledge, tools and memory; prepares transactions; sponsors the network fee; indexes the chain. |
| **System keys** | `ADMIN` (**cold**, off the server: approves Solvers, judges disputes, slashes stake, changes config, upgrades contracts) · `PLATFORM` (server: holds the stablecoin **float**, buys on the buyer's behalf for Pix and agent payments, records usage) · `VERIFIER` (server: marks a milestone as "passed the tests", records eval scores) · `RELAY` (server: **only pays fees**, holds no contract role) · `GUARDIAN` (can only switch a pause **on**) · `TREASURY` (cold wallet that receives the platform fee and royalty). Separate keys: a leak of the fee key cannot touch the float or any role. |
| **Emergency pause** | Three switches: new entries (purchases, registrations), payments (milestone release, dispute rulings) and license transfers. The admin turns any of them on or off; a guardian can only turn entries/payments **on** (never transfers, never off). Buyer exits (open a dispute, cancel an undelivered task, refund a stale dispute) are never paused. |

---

## 4. Creator flow

> Full guide: [creator-guide.md](creator-guide.md). The flow runs end to end on a local chain and was exercised once on Moderato (a test Solver).

### 4.1 Building the package
The folder `agents/<slug>/`: `manifest.json` (name, price, royalty share, steps, tools, free trial, guarantee, license cap), `steps/` (one `.md` per step, with a "gate" checklist), `knowledge/` (texts the AI consults), `templates/`, `evals/` (test cases). Full format: `PACKAGE_SPEC.md`. Packages are English-primary, with an optional Portuguese translation in `locales/pt.json`.
The creator does not have to write everything by hand: there is the **Solver Builder** (`criador-de-solvers`), a **free platform Solver** (database only, no blockchain) that, inside the creator's Claude/ChatGPT, walks through **7 steps** (promise, differentiators, steps, knowledge, tools, calibration, evals), consults the server's validator and delivers the ZIP.

### 4.2 How a package passes the tests (3 layers)

| Layer | What it does | Who decides |
|---|---|---|
| **1. Validator** (structure) | A single schema in code (zod), **68 codes** (3 of them reserved for later phases), each an error `E` (blocks) or a warning `A`. ZIP with no `..`/links/giant files, paths locked inside the folder, sizes, `slug`/version, price >= 5, steps with the required sections, knowledge with a source and a date, **>= 10 eval cases**, **>= 2 of 5 "differentiators"** proven by the package itself, third parties **with no tools, no guarantee, no regulated categories** (Finance, Legal, Health). It runs on its own at upload and also in `cli:validate`. | Machine (an error blocks the submission) |
| **2. Scans** ("is it malicious?") | **Warnings** shown to the reviewer: invisible or bidirectional Unicode, hidden HTML/CSS, remote images, prompt-injection phrases, requests for sensitive data, data-exfiltration URLs, **content copied from another published package**, off-topic search phrases, expired knowledge. | Machine warns, **human decides** |
| **3. Evals** ("does it work?") | Cases with simple checks (`regex`, `contains`, `not_contains`) applied to **answers generated beforehand** with the Solver active. Produces `report.json` (score in `scoreBps`, 8750 = 87.5%). | Machine |

**Limits you should be able to state:** the scans are **heuristics that can be bypassed**; nobody guarantees finding an injection hidden in one chunk among thousands. The real defense is **invite + caps + human review of 100% of versions + fast shutdown**. The server **never runs third-party code**. Performance rating: third parties **do not have one** (buyer reviews only); team packages show "**internal team test**", never "verified".

### 4.3 Upload, validation and human review

1. **Invite:** the team generates a code `SLV-XXXX-XXXX-XXXX` (`cli:invite create`) and sends it by email. It works once and gets bound to the wallet of whoever uses it.
2. **Profile:** on `/creator/publish` the creator signs in, fills in name and bio, accepts the terms and enters the code. The escalation contact (Telegram) becomes "verified" when the creator links it with a one-time `LINK-XXXXXXXX` code sent to the bot.
3. **ZIP upload:** the server only **stores the file and answers immediately**. Limits: ZIP 50 MB, 150 MB extracted, 2,000 files, 10 MB per file, only `.json/.md/.txt`, **3 submissions in progress** and **5 per day** per creator.
4. **Worker:** a **separate** process (`solvers-tempo-worker`, so it cannot take down the API) extracts, validates, scans and indexes the knowledge in a **staging** area, resuming where it stopped if restarted.
5. **Human review** at `/admin/reviews` (wallets in `ADMIN_WALLETS`; a site permission that **signs nothing on the blockchain**). The reviewer sees validator results, the manifest, a **diff of all files** against the published version, test searches, scans and differentiators, all as escaped text. To approve they tick the whole checklist and write a reason; they can also request changes, reject or revoke. Everything goes into an **insert-only trail**.
6. **Co-signing:** once approved, the **creator signs one batched transaction** in their wallet (`registerAgent` for a new Solver, plus the stake approval and supply cap when needed; `updateVersion` for an update); the platform relay pays the fee. The platform **never holds a creator's key**.
7. **On-chain approval (new Solver only):** the owner runs `cli:approve <slug>` with the **cold admin key** (`approveAgent`; the fee is sponsored, so the cold key holds no tokens). It only approves if the on-chain Solver **matches** the version approved on the site. Only then does the Solver appear on the storefront.

**New version:** same `slug`, a **higher** `version`, and it **goes through the whole review again**.
**Possible cheating and the defense:** the creator can call `updateVersion`/`updatePricing` **directly on-chain**, without review. The indexer compares with the approved versions; if they diverge, it flags `unapproved_chain_version`, **keeps serving the approved package** and **blocks sales** (`price_in_review`) until a review approves it or the creator reverts.

Platform Solvers (like the Solver Builder) **do not go through this flow**: the authority is a list on the server (`PLATFORM_AGENTS`), not a manifest field, and they ship through `cli:publish`.

### 4.4 What goes on the blockchain at publication
- **The creator signs:** `registerAgent` (price, price per use, royalty share, version fingerprint, metadata link; the stake is pulled if `minStake > 0`) and, optionally, `setSupplyCap`.
- **The cold admin signs:** `approveAgent` (without it the Solver stays `Pending` and cannot sell).
- Each new version: `updateVersion` (new fingerprint). The eval score is stored **per version**: it is never erased, but a score measured for an older version shows as "not measured for this version" until a new one is recorded (`setEval`, platform packages only).
- What does **not** go there: the package, the ZIP, the review text.

On-chain Solver states: `Pending -> Active <-> Suspended`, and `Retired` (the creator asked to leave; the stake only comes out after 30 days).
**Kill switch:** `cli:suspend <slug>` does **both**: `platform_status = suspended` in the database (drops sessions, listing and sales at once) **and** `suspendAgent` on-chain (otherwise a direct purchase through the contract would still work). `--resume` undoes it. A Solver also leaves the storefront on its own with an **average rating below 3.5 after 10 reviews** (existing buyers keep using it).

### 4.5 The creator's money
At purchase, **in the same transaction**: the platform fee (10% by default, capped at 20%, rounded down) goes to the treasury and the rest goes **straight to the creator's wallet**. The network fee is never deducted from anyone's share. If the creator's wallet refuses incoming payments, the contract holds the amount for them (Claim). There is no license refund. Every later transfer of the license pays the creator a **royalty** (section 9). Details: [economics.md](economics.md).

---

## 5. Human buyer flow

1. **Sign in:** email through Privy (creates an embedded wallet) or a wallet on test networks. Signing in = signing a SIWE message -> session.
2. **Choose and pay:** storefront -> checkout. Options: **wallet** (stablecoin) or **Pix**. On Moderato Pix is **simulated** (no bank involved). Mainnet rejects simulation, and Pix stays off on mainnet until the open questions in [payments-open-questions.md](payments-open-questions.md) are answered.
3. **Wallet path:** the server writes a purchase record first (`POST /api/purchases/intent`) and returns the calls `[approve, purchaseLicense]` with the **price the user saw**: if the creator changes the price midway, the purchase **fails** (`PriceChanged`) instead of charging a different amount. The wallet signs one batched transaction; the relay pays the fee.
4. **The contract checks and executes all or nothing:** is the Solver `Active`? stake >= minimum? price >= 5? not paused? cap not reached? buyer is not the creator? Then it splits the payment (platform fee / creator), **mints the NFT to the buyer's wallet** and adds the purchase to the buyer's reputation.
5. **Event -> indexer -> database -> `list_my_solvers` shows it.** If the database has not seen it yet, the connector checks the chain directly.

**Pix path:** one Pix charge buys one thing for one buyer. Once the payment is confirmed, the platform buys it on-chain **for the buyer** from its own stablecoin float (`purchaseLicenseFor`); the buyer never holds the stablecoin. Webhook replays never produce a second purchase (each charge has a purchase id the contract accepts only once). Details: [payments.md](payments.md).

**License cap:** the creator can set a limit (e.g. 10). The **contract** blocks sales beyond it (`SoldOut`); transferring or burning a license does **not** free a slot; the creator can only **raise** the cap. Never promise "only N will exist": say "the current limit is N and it can only go up". Details: [license-cap.md](license-cap.md).
**Other things to buy:** **credits** (pay per use, `buyCredits`; they exist on-chain and also allow a review) and a **per-task guarantee** (section 8). Today the connector unlocks a Solver through a license, an open guarantee, a free trial or a platform Solver.

---

## 6. Using the Solver (MCP connector)

1. **Connect:** the user pastes the connector address (`/mcp` on the Solvers API; not deployed on a public domain yet) into Claude/ChatGPT. `/mcp` answers 401 -> the client discovers **OAuth** by itself (automatic registration + PKCE) -> opens the "Connect your wallet" page -> the user signs (SIWE) -> the client receives a token **bound to the wallet**.
2. **Tools** (15; the AI calls them on its own): `list_my_solvers`, `find_solver` (search by meaning), `get_purchase_link`, `activate_solver`, `preflight_check`, `next_step`, `search_knowledge`, `run_tool`, `get_memory`, `save_memory`, `forget_memory`, `submit_deliverable`, `escalate_to_creator`, `list_open_guarantees`, `get_template`.
3. **Flow:** `activate_solver` checks the license (or guarantee, or trial) and opens a **session** -> `preflight_check` (does the AI have the required tools?) -> `next_step` delivers **one step at a time** (with a checklist the AI must complete) -> `search_knowledge` (**RAG**, section 7.1).
4. **Free trial:** limits set by the creator in the manifest (uses, steps, searches, tool runs), counted **per person**: wallets linked to the same verified email count as one. **Agents get no trial** (a new wallet costs nothing).
5. **Memory and calibration** (section 7.2): encrypted user preferences; the key comes from a **second signature** by the user.
6. **Review** (on the site): requires a **license** (or purchased credits). One license backs **one** review; the creator cannot review their own Solver. The text stays off-chain; **only the fingerprint + a 1-5 rating** go on-chain.
7. **Escalate:** `escalate_to_creator` sends a summary to the creator's Telegram (a human fallback).
8. **Usage log:** each verified use becomes a receipt; every 10 min a **batch** records the count + Merkle root on-chain (`recordUsageBatch`).

---

## 7. RAG and calibration (how the specialist "knows" and "adapts")

Two problems, two pieces. **Neither trains or alters the AI model** (Claude/ChatGPT stay exactly the same).

| | **RAG** (what the specialist knows) | **Calibration** (what it knows about you) |
|---|---|---|
| **Analogy** | A **library with a librarian**: instead of memorizing everything, the AI asks and receives only the right pages. | A **client file**: on the first visit the clerk asks the essentials and writes them down. |
| **Whose it is** | The creator's (the same for every buyer). | The user's (one file per wallet **and** per specialist). |
| **Where it lives** | Database, as chunks with vectors. | Database, **encrypted** (memory). |
| **When it acts** | When the AI calls `search_knowledge`. | On first use (`get_memory`) and in every step that reads the profile. |

### 7.1 RAG (Retrieval-Augmented Generation = "look it up before answering")

**Why it exists:** the AI cannot receive the whole knowledge base every time (expensive, slow, and it would give the product away). So the texts stay on the server and the AI gets **only 5 chunks** per query.

**Preparation (at publication, once):**
1. The creator writes `.md`/`.txt` texts in `knowledge/`, each with a header: title, **source**, source date, validity and, optionally, `trial: true` (unlocked in the free trial).
2. The server **cuts them into chunks** of about 2,000 characters, respecting headings and paragraphs, with about 200 characters repeated between chunks so an idea is not cut in half.
3. Each chunk becomes a **vector** (an embedding): 384 numbers that represent the text's **meaning**. The model runs locally on the server (`multilingual-e5-small`), at zero cost and without sending text to third parties. Vectors go into Postgres with pgvector.

**At use:**
1. The AI calls `search_knowledge` with its question. The server turns it into a vector and finds the **5 closest chunks**, only from the **Solver and version** the user has.
2. Each chunk comes back with **title, source and date**; an expired one comes with a "may be out of date" warning, and the AI is told to **cite the source**.
3. Every answer carries a **watermark** (a phrase that varies by wallet). It is a hint, not proof: many wallets share the same phrase.
4. Protections: a **daily quota** of searches (300 by default), only `trial: true` files in the free trial, nothing without access.

**Same idea, another use:** `find_solver` and the storefront search also use vectors (one per Solver and one per search phrase). If the model did not load, it falls back to Postgres keyword search.

**Limits to be able to state:** RAG **finds** chunks, it does not guarantee the AI uses them well; quality depends on what the creator wrote; meaning-based search can return a similar but wrong chunk (which is why source and date are shown).

### 7.2 Calibration: "fine-tuning" without training anything

**Real fine-tuning** = retraining the model with your data. **We do not do that.** We **ask the first time, store the answers and make every step read the file**.

**How the creator configures it:** in `manifest.onboarding`, **1 to 5 questions**, each with `ask`, `why` (why it is asked) and optional `options` (2 to 6).

**Flow on first use:**
1. The user activates the Solver. The server tells the AI to call `get_memory` **before step 1**.
2. No file yet -> the answer carries the questions. The AI asks them in **at most 2 messages**, explaining each. **Every question can be skipped.**
3. The AI saves the answers (`save_memory`, kind `profile`). Skipped -> saved as skipped, not asked again every session.
4. Later steps read the profile and **adapt** examples and choices. The user can ask to "recalibrate" at any time.
5. Beyond calibration, the AI stores **notes** (up to 30) only when the **user asks**.

**Safety rules:** the profile is **user data, not instruction**: it **cannot remove steps or checklist items**. The file is **encrypted** (AES-256-GCM, key derived with HKDF from a wallet signature, which is why smart-contract wallets cannot unlock memories). It is encryption at rest: the server opens it while the token is valid, so **do not promise "only you can read it"**. Memory belongs to the **wallet + specialist**, does **not travel** with a transferred license, and the user can **delete** everything from the site.

---

## 8. Guarantee (escrow)

**Analogy:** you hire a painter and leave the money **in a notary's vault**. The painter only gets paid if the wall passes inspection. If not, the money comes back.

**What escrow is here:** the `SolversEscrow` contract holds the money, with up to **5 milestones**, each with an amount and a **criterion agreed beforehand** (`criteriaHash`). Nobody, not even the platform, can take the money out outside the rules.

| # | What happens | Who |
|---|---|---|
| 1 | Task, milestones, amounts, tests and delivery deadline are agreed (default 14 days, max 60). The money goes from the buyer to the contract (`createEscrow`, or `createEscrowFor` when paid by Pix). | Buyer signs (or the platform for Pix) |
| 2 | The AI delivers (`submit_deliverable`). The server runs the tests **agreed beforehand** in a **disposable Docker container**: no internet, limited CPU/memory, no privileges. | Server |
| 3 | Passed -> `markPassed` on-chain (with the deliverable's fingerprint) + a **watermarked preview**. The files are only released after approval. | `VERIFIER` |
| 4a | The buyer is happy -> `releaseMilestone`: the creator is paid (minus the fee). | Buyer |
| 4b | The buyer does nothing -> the **review window** passes (from 1 minute to 30 days; 72 h by default) -> **automatic release** (a job checks every minute). | Anyone / job |
| 4c | Not happy -> `openDispute` -> the **admin judges** (`resolveDispute`: refund or pay). If there is no ruling within **7 days** and nothing was delivered, anyone can send it back to the buyer (`resolveStaleDispute`). | Admin |
| 5 | The creator **never delivered** by the deadline -> the buyer cancels that milestone (`cancelUndelivered`), **no fee**. | Buyer |

There is no "closing" step: when every milestone is paid or refunded, the guarantee is simply finished.
**Protections:** a buyer who loses **3** disputes cannot open a new guarantee. Limits by buyer reputation: **new account (fewer than 3 purchases) up to 20** open in guarantees (above 10, at least 2 milestones) · trusted up to 500 · none after 3 lost disputes. These limits are enforced by the server; the contract itself checks only the lost-dispute count. Minimum purchase 5. The fee is **frozen at creation**.
**Creator stake:** if they cheat, the admin **proposes a slash** -> **72 h** wait -> the creator can contest once -> the admin **executes** within 14 days (the money goes to the treasury). With `minStake` at 0 there is little to slash today. Only Solvers with enough sales and rating offer a guarantee (`GUARANTEE_MIN_SALES`, `GUARANTEE_MIN_RATING`); the dispute decision is **a manual admin call**.

---

## 9. Transferring a license (with a royalty)

A license is an NFT, so its owner can **give or sell it to another wallet**. Every transfer pays a **royalty**, enforced by the License contract itself (there is no way around it, not even through another marketplace):

- **creator share**: set per Solver from the manifest (`royaltyBps`, for example 5%), fixed at registration and changeable only before the first sale;
- **platform share**: a Registry setting (5% by default) that goes to the treasury;
- both are a percentage of the **original price** of that license (not of any new sale price), each rounded down; the two together can never exceed **25%**;
- the **current owner** pays it, in the stablecoin, at the moment of the transfer. If they did not approve the amount, the transfer fails (`RoyaltyNotPaid`) and nothing moves.

Example: a license bought for 19 pays 0.95 to the creator and 0.95 to the platform on each transfer (5% + 5%). On the site, the library's **Transfer** dialog shows the exact amounts and sends one batched transaction `[approve the royalty, transferWithRoyalty]`, with the fee sponsored. Burning a license pays nothing and frees no cap slot; transferring frees no cap slot either. Memories do **not** travel with the license. The admin can pause transfers in an emergency. The 5% + 5% defaults still await the owner's confirmation. Details: [royalties.md](royalties.md).

---

## 10. Autonomous purchases: MPP

**MPP** (Machine Payments Protocol, Tempo's protocol for machine payments) uses the HTTP **402 "Payment Required"** code so a robot can pay over the internet with no account, card or human.

**Step by step (`POST /api/agent-pay/solvers/:id/license`):**
1. The agent asks to buy. The server creates an **order with a locked price** and answers **402** with a `WWW-Authenticate: Payment` challenge (how much, which token, which network).
2. The agent's MPP client (`mppx`) signs a stablecoin transfer and **repeats the request** with the `Authorization: Payment` header. The **server co-signs as fee payer** (the RELAY key) and sends it: the agent pays **only the price**, never a fee.
3. The payment lands in the platform's **float** (the PLATFORM wallet), and seconds later the platform runs `purchaseLicenseFor(agent wallet)` from that same float. The license goes **to the wallet that paid**. The treasury still receives the platform fee through the contract split.
4. If the payment went through but the license **cannot** be issued, the order is **refunded** to the payer.

**Why the float holds the money for a moment:** the payment is a single transfer, and the license purchase is a separate contract call made by the platform. How this custody should be treated is an open question for the owner ([payments-open-questions.md](payments-open-questions.md) §6).
**Rules:** price between **5 and 100** per purchase (configurable), orders expire after 15 minutes, at most 5 open orders per IP; no free trial; already owning the Solver is refused (`already_owned`); the cap and the pause apply. Agent payments are **off by default** (`AGENT_PAY_ENABLED`).
**The other way:** an agent with its own wallet can also buy **directly** (`[approve, purchaseLicense]` through the relay, like the website).
**Getting into the connector without a browser:** `GET /oauth/agent/nonce` + `POST /oauth/agent/token` (sign a SIWE message with the agent's key; 2 calls). The message says "**This does not authorize payments**": login never moves funds. Details: [agent-login.md](agent-login.md), [agent-payments.md](agent-payments.md).
**Status:** exercised end to end on Moderato (2026-10-11); mainnet waits for the owner's decisions.

---

## 11. What is real and what is not yet

| Real (on Moderato, test money) | Simulated / planned |
|---|---|
| Sponsored purchases, NFT licenses, cap, transfer with royalty, credits, reviews, guarantees with Docker tests, stake rules, agent payments over MPP, the creator flow (a test Solver published) | Pix (simulated, no bank) · the stablecoin is faucet test money · dispute arbitration = manual admin · `minStake` at 0 · Privy email login (supported in code, not yet tested live: needs the owner's Privy app) · public deployment of the new server (domain created, not deployed) · mainnet (planned, payment token not chosen) |

---

## 12. Questions you need to be able to answer

1. **Where does the license live?** In an NFT in the user's wallet. Access is unlocked by our server reading the wallet.
2. **What does the blockchain store and what not?** Owner, price, sales, ratings (fingerprint), credits, guarantee, stake, version hash, eval per version, cap. It does **not** store the content, memories, sessions or the review text.
3. **Who pays the network fee?** The platform, always, through its relay. Tempo has no gas coin: fees are paid in a stablecoin by the RELAY key. Nothing is deducted from the price or from anyone's share.
4. **Why a 5 minimum?** It is the marketplace minimum (`minPrice` in the Registry config), applied by the contracts to every purchase: license, credits and guarantee. The admin can change it.
5. **How do I know a Solver is not malicious?** Invite + validator + scans (warnings) + human review of 100% of versions with a diff + no execution of third-party code + kill switch. There is no absolute guarantee.
6. **How do I know it works?** Evals (cases with checks); the score only goes on-chain for platform packages, per version, labelled "internal team test".
7. **What is escrow and who decides?** Money held by the Escrow contract; automatic tests mark milestones, the buyer approves or disputes, the **admin judges**, and deadlines resolve things on their own (auto-release, 7 days of dispute, delivery deadline).
8. **What if the creator disappears?** Guarantee: cancel without a fee after the deadline. A license already paid for: no automatic refund (hence the stake, the kill switch and curation).
9. **What happens when a license changes hands?** The current owner pays the royalty (creator share + platform share of the original price); the new owner gets access; memories stay with the old wallet; no cap slot is freed.
10. **What is MPP and why does the platform hold the payment for a moment?** HTTP payment for robots; the agent pays the float, the platform buys in the agent's name from that float, delivers the NFT to the payer and refunds if it fails.
11. **Can an agent see the content without paying?** No: without a license there is no content, and agents get no trial.
12. **Can the creator "freeze" the offer?** They can cap licenses, but the cap only **goes up**; do not promise eternal scarcity.
13. **Who can move the money?** Only the contracts, under their rules. The server keys cannot withdraw from the vaults; `ADMIN` is cold; `RELAY` only pays fees.
14. **What is RAG?** Look it up before answering: the creator's knowledge becomes chunks with "meaning as numbers" (vectors); the AI receives only 5 relevant chunks with source and date. It does not train the model.
15. **RAG vs. memory?** RAG = what the specialist knows (from the creator, the same for everyone). Memory = what it knows about you (from your wallet).
16. **What does mainnet require?** The owner's decisions (payment token, royalty percentages, admin custody, Privy app, domain), answers to [payments-open-questions.md](payments-open-questions.md), simulations off, fresh keys and the deploy runbook.

---

## 13. Where everything is in the code

| Topic | File |
|---|---|
| On-chain rules | `contracts/src/*.sol` (Registry, License, Credits, Reviews, Escrow, Staking) |
| Chain client (calls, relay, errors) | `packages/chain/src`, generated ABIs in `packages/contracts-client` |
| Validator, scans | `apps/server/src/runtime/validate/`, `apps/server/src/review/` |
| Publishing | `apps/server/src/publish/`, `apps/server/src/cli/publish.ts`, `cli/approve.ts`, `cli/suspend.ts` |
| Evals | `scripts/src/eval.ts`, `agents/<slug>/evals/` |
| MCP connector, OAuth, agent login | `apps/server/src/mcp`, `apps/server/src/oauth` |
| Sign-in (SIWE, Privy) | `apps/server/src/auth` |
| Fee sponsorship (relay) | `apps/server/src/relay`, `apps/server/src/chain/lanes.ts` |
| Payments (wallet, Pix, agents) | `apps/server/src/payments`, `pix`, `agent-pay` |
| Guarantee and Docker tests | `apps/server/src/verifier`, `store/escrow.ts`, `jobs.ts` |
| Indexer | `apps/server/src/indexer` |
| RAG (chunking, vectors, search, quota) | `apps/server/src/knowledge` |
| Memory and calibration | `apps/server/src/memory`, `mcp/tools.ts` (`get_memory`, `save_memory`) |
| Web app | `apps/web/src` (wallet and transactions in `src/lib`) |
