// Unit tests of the web's pure helpers: error mapping (API codes, contract custom errors by name, wallet cancel,
// sponsor declined), the dev-wallet guard, token amount formatting and the hash-signer account (Privy shape) producing
// byte-identical Tempo transactions to viem's private-key account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError } from "@solvers/api-client";
import { solversAbi } from "@solvers/contracts-client";
import { BaseError, encodeErrorResult, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { Transaction } from "viem/tempo";
import { ClientError, contractErrorName, errorInfo, errorText, isUserRejection, UserFacingError, type ErrorsT } from "../src/lib/error-map";
import { formatToken, formatUnits, toBigUnits } from "../src/lib/format-money";
import { hashSignerAccount } from "../src/lib/wallet/account";
import { DEV_WALLET_STORAGE_KEY, devWalletBlock, forgetDevKey, loadDevAccount, readDevKey } from "../src/lib/wallet/dev";
import { SponsorDeclinedError, VALIDITY_SECS, clockOffsetSecs, isSponsoredFill, serverClock } from "../src/lib/wallet/send";
import { privyChainMismatch } from "../src/lib/wallet/privy-chain";
import { restoreChoice } from "../src/lib/wallet/restore";
import { contentSecurityPolicy, makeNonce } from "../src/lib/csp";

type Tree = { [k: string]: string | Tree };
const messages = (locale: string): Tree => JSON.parse(readFileSync(new URL(`../messages/${locale}/errors.json`, import.meta.url), "utf8")) as Tree;

/** Minimal translator over errors.json ({name} placeholders only), with `has` like next-intl. */
function translator(locale: "en" | "pt"): ErrorsT {
  const root = messages(locale);
  const get = (key: string): string | undefined => {
    let cur: string | Tree | undefined = root;
    for (const part of key.split(".")) cur = typeof cur === "object" ? cur[part] : undefined;
    return typeof cur === "string" ? cur : undefined;
  };
  const t = ((key: string, values?: Record<string, string | number>) => {
    const s = get(key);
    if (s === undefined) throw new Error(`missing message errors.${key}`);
    return s.replace(/\{(\w+)\}/g, (_m, k: string) => String(values?.[k] ?? `{${k}}`));
  }) as ErrorsT;
  t.has = (key: string) => get(key) !== undefined;
  return t;
}

const en = translator("en");
const pt = translator("pt");
const token = { symbol: "USD", decimals: 6 };

/** Revert data of a Solvers custom error, with zero values for its arguments. */
const revertData = (name: string) => {
  const item = solversAbi.find((x) => x.type === "error" && x.name === name) as { inputs: { type: string }[] } | undefined;
  if (!item) throw new Error(`no error ${name}`);
  const zero = (type: string): unknown =>
    type.startsWith("uint") || type.startsWith("int") ? 0n : type === "address" ? `0x${"0".repeat(40)}` : type === "bool" ? false : type.startsWith("bytes") ? `0x${"0".repeat(64)}` : "";
  return encodeErrorResult({ abi: solversAbi, errorName: name as never, args: item.inputs.map((i) => zero(i.type)) as never });
};

// ----- error mapping -----

test("contract errors are decoded by name from viem errors, node messages and relay messages", () => {
  class FakeRevert extends BaseError {
    data: Hex;
    constructor(data: Hex) {
      super("execution reverted");
      this.data = data;
    }
  }
  assert.equal(contractErrorName(new FakeRevert(revertData("SoldOut"))), "SoldOut");
  // anvil/Tempo nodes print the selector and the arguments in the message (measured in test/wallet-send.test.ts)
  const data = revertData("PriceChanged");
  const nodeMsg = new Error(`Execution reverted with reason: custom error ${data.slice(0, 10)}: ${data.slice(10)}.`);
  assert.equal(contractErrorName(nodeMsg), "PriceChanged");
  assert.equal(contractErrorName(new Error("relay: simulation reverted: DuplicatePurchase")), "DuplicatePurchase");
  assert.equal(contractErrorName(new Error("something else")), null);
  assert.equal(contractErrorName(new ApiError(409, "simulation_failed", "x", { error: "SelfPurchase" })), "SelfPurchase");
});

test("every contract error the chain package knows has an en and pt text", async () => {
  const { SOLVERS_ERROR_MESSAGES } = await import("@solvers/chain/browser");
  for (const name of Object.keys(SOLVERS_ERROR_MESSAGES)) {
    assert.ok(en.has(`contract.${name}`), `en contract.${name}`);
    assert.ok(pt.has(`contract.${name}`), `pt contract.${name}`);
  }
});

test("contract errors map to friendly text (specific titles for sold out and price changes)", () => {
  const so = revertData("SoldOut");
  const soldOut = errorInfo(new Error(`custom error ${so.slice(0, 10)}: ${so.slice(10)}`), en);
  assert.equal(soldOut.code, "contract:SoldOut");
  assert.equal(soldOut.title, "Sold out");
  assert.ok(!/market|only \d+ will exist/i.test(soldOut.text), "no secondary market and no fixed-supply promise");
  const self = errorInfo(new Error("simulation reverted: SelfPurchase"), pt);
  assert.equal(self.text, "O criador não pode comprar o próprio especialista.");
  assert.equal(self.contractError, "SelfPurchase");
  const paused = errorInfo(new Error("simulation reverted: Paused"), en);
  assert.equal(paused.title, "Paused for a moment");
  const balance = errorInfo(new Error("simulation reverted: InsufficientBalance"), en, { faucetEnabled: true });
  assert.equal(balance.action, "faucet");
  assert.equal(errorInfo(new Error("simulation reverted: InsufficientBalance"), en).action, null, "no faucet off testnets");
});

test("API errors: codes, amounts from base units with the token symbol, login and retry actions", () => {
  const funds = errorInfo(new ApiError(400, "insufficient_funds", "x", { balanceUnits: "1500000", neededUnits: "12000000" }), en, { token, intlLocale: "en-US" });
  assert.equal(funds.text, "You have 1.50 USD and need 12 USD.");
  const fundsPt = errorInfo(new ApiError(400, "insufficient_funds", "x", { balanceUnits: "1500000", neededUnits: "1234500000" }), pt, { token, intlLocale: "pt-BR" });
  assert.equal(fundsPt.text, "Você tem 1,50 USD e precisa de 1.234,50 USD.");
  const price = errorInfo(new ApiError(409, "price_changed", "x", { priceUnits: "9990000" }), en, { token, intlLocale: "en-US" });
  assert.equal(price.text, "The solver's price is now 9.99 USD. Check the new amount and confirm again.");
  assert.equal(errorInfo(new ApiError(401, "unauthorized", "x", {}), en).action, "login");
  assert.equal(errorInfo(new ApiError(503, "internal", "x", {}), en).action, "retry");
  assert.equal(errorText(new ApiError(409, "sold_out", "x", {}), en), "All licenses allowed for this solver have been sold. You weren't charged.");
  assert.equal(errorText(new ApiError(404, "not_found", "Not found", {}), pt), "Não encontramos o que você procurava.");
  // unknown code: the server's message
  assert.equal(errorText(new ApiError(400, "weird_code", "Server says no", {}), en), "Server says no");
});

test("wallet cancel, sponsor declined and client codes", () => {
  assert.equal(isUserRejection(Object.assign(new Error("User rejected the request."), { code: 4001 })), true);
  assert.equal(isUserRejection(new ClientError("cancelled", "exited_auth_flow")), true);
  assert.equal(isUserRejection(new Error("boom")), false);
  assert.equal(errorInfo(Object.assign(new Error("x"), { code: 4001 }), en).code, "cancelled");
  const declined = errorInfo(new SponsorDeclinedError(), en);
  assert.equal(declined.code, "sponsor_declined");
  assert.match(declined.text, /nothing was charged/);
  assert.equal(errorInfo(new ClientError("wallet_changed"), pt).title, "Sua carteira mudou");
  assert.equal(errorInfo(new ClientError("dev_wallet_mainnet"), en).title, "Test wallet not allowed here");
  // library errors never reach the screen verbatim; short app errors do
  assert.equal(errorText(new TypeError("Cannot read properties of undefined"), en), en("tx.unknown.text"));
  // plain `Error`s (raw English) show the generic localized text; only app text marked as user-facing is shown as is
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(errorText(new Error("no calls to send"), pt), pt("tx.unknown.text"));
  } finally {
    console.error = quiet;
  }
  assert.equal(errorText(new UserFacingError("A translated message from the app."), en), "A translated message from the app.");
  assert.equal(errorInfo(new TypeError("Failed to fetch"), en).code, "network");
});

test("every client error code used by the wallet layer has a title and text in both languages", () => {
  const codes = [
    "unconfirmed", "transaction_failed", "sponsor_declined", "wrong_network", "wallet_changed", "wallet_not_connected", "login_failed",
    "login_timeout", "login_interrupted", "login_loading", "create_wallet_failed", "dev_wallet_mainnet", "dev_wallet_disabled",
    "privy_not_configured", "network_unknown", "session_not_created", "cancelled", "privy_chain_mismatch",
  ];
  for (const c of codes) for (const t of [en, pt]) assert.ok(t.has(`tx.${c}.title`) && t.has(`tx.${c}.text`), c);
});

// ----- dev wallet guard -----

test("dev wallet: needs the build flag, never on mainnet (build or runtime chain id), waits for the network", () => {
  assert.equal(devWalletBlock({ allowFlag: undefined, buildChainId: "42431", runtimeChainId: 42431 }), "not-enabled");
  assert.equal(devWalletBlock({ allowFlag: "0", buildChainId: "42431", runtimeChainId: 42431 }), "not-enabled");
  assert.equal(devWalletBlock({ allowFlag: "1", buildChainId: "4217", runtimeChainId: 42431 }), "mainnet");
  assert.equal(devWalletBlock({ allowFlag: "1", buildChainId: "42431", runtimeChainId: 4217 }), "mainnet");
  assert.equal(devWalletBlock({ allowFlag: "1", buildChainId: undefined, runtimeChainId: 4217 }), "mainnet");
  assert.equal(devWalletBlock({ allowFlag: "1", buildChainId: "42431", runtimeChainId: null }), "unknown-network");
  assert.equal(devWalletBlock({ allowFlag: "1", buildChainId: "42431", runtimeChainId: 42431 }), null);
  assert.equal(devWalletBlock({ allowFlag: "1", buildChainId: "", runtimeChainId: 31337 }), null);
});

test("dev wallet key: created once, reused, malformed values ignored, forgettable", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  assert.equal(loadDevAccount(false, store), null);
  const a = loadDevAccount(true, store)!;
  assert.match(data.get(DEV_WALLET_STORAGE_KEY)!, /^0x[0-9a-f]{64}$/);
  assert.equal(loadDevAccount(false, store)!.address, a.address);
  data.set(DEV_WALLET_STORAGE_KEY, "not-a-key");
  assert.equal(readDevKey(store), null);
  forgetDevKey(store);
  assert.equal(data.has(DEV_WALLET_STORAGE_KEY), false);
});

// ----- amounts -----

test("token amounts are formatted from base units without float math", () => {
  assert.equal(formatUnits(12_500_000n, 6, "en-US"), "12.50");
  assert.equal(formatUnits("5000000", 6, "en-US"), "5");
  assert.equal(formatUnits("1234567891234567", 6, "pt-BR"), "1.234.567.891,234567");
  assert.equal(formatUnits("1", 6, "en-US"), "0.000001");
  assert.equal(formatToken("19990000", token, "pt-BR"), "19,99 USD");
  assert.equal(formatUnits("12.5", 6, "en-US"), null, "decimal strings are not base units");
  assert.equal(toBigUnits(Number.MAX_SAFE_INTEGER + 2), null);
});

// ----- accounts -----

test("hash-signer account (Privy shape) produces the same Tempo transaction as viem's private-key account", async () => {
  const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
  const pk = privateKeyToAccount(key);
  const hs = hashSignerAccount({
    address: pk.address,
    signHash: (hash) => sign({ hash, privateKey: key, to: "hex" }),
    signMessage: (message) => pk.signMessage({ message }),
  });
  const tx = {
    type: "tempo",
    chainId: 42431,
    nonce: 3,
    gas: 900_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    calls: [{ to: "0x20c0000000000000000000000000000000000000", data: "0x095ea7b3" }],
    validBefore: 1_900_000_000,
    feePayerSignature: { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 1 },
  } as const;
  const serializer = Transaction.serialize as never;
  const a = await pk.signTransaction(tx as never, { serializer });
  const b = await hs.signTransaction(tx as never, { serializer });
  assert.equal(b, a);
  assert.equal(await hs.signMessage({ message: "hello" }), await pk.signMessage({ message: "hello" }));
  assert.ok(a.startsWith("0x76"), "a Tempo 0x76 envelope");
  assert.equal(keccak256(toBytes(a)).length, 66);
});

test("a fill without the fee payer's co-signature is not sponsored", () => {
  assert.equal(isSponsoredFill({ feePayerSignature: { r: "0x1", s: "0x2", yParity: 0 } }), true);
  assert.equal(isSponsoredFill({ feePayerSignature: null }), false);
  assert.equal(isSponsoredFill({}), false);
  assert.equal(isSponsoredFill(null), false);
});

// ----- review fixes (M2, L3, L4, L5) -----

test("validBefore follows the server clock, inside the relay's 120 s window whatever the device clock says", () => {
  const server = 1_900_000_000;
  for (const skewSecs of [-3600, -90, 0, 90, 3600]) {
    const localMs = (server - skewSecs) * 1000; // the device clock is off by skewSecs
    const offset = clockOffsetSecs(server, localMs);
    const now = serverClock(offset, () => localMs + 2_000)(); // 2 s later on the device
    assert.equal(now, server + 2);
    const validBefore = now + VALIDITY_SECS;
    assert.ok(validBefore > server + 2 && validBefore <= server + 2 + 120, `skew ${skewSecs}`);
  }
  assert.equal(clockOffsetSecs(Number.NaN, Date.now()), 0, "no server time: no offset");
  assert.ok(VALIDITY_SECS <= 60);
});

test("Privy chain: the build's chain must be the API's", () => {
  assert.equal(privyChainMismatch(42431, 42431), null);
  assert.equal(privyChainMismatch(null, 42431), null, "no build id: Moderato");
  assert.equal(privyChainMismatch(4217, 4217), null);
  assert.deepEqual(privyChainMismatch(null, 4217), { privy: 42431, api: 4217 });
  assert.deepEqual(privyChainMismatch(4217, 42431), { privy: 4217, api: 42431 });
  assert.deepEqual(privyChainMismatch(42431, 31337), { privy: 42431, api: 31337 });
});

test("restore: the source whose address is the session wallet wins", () => {
  const P = "0x1111111111111111111111111111111111111111";
  const D = "0x2222222222222222222222222222222222222222";
  assert.equal(restoreChoice({ privy: null, dev: null }), null);
  assert.equal(restoreChoice({ privy: P, dev: null }), "privy");
  assert.equal(restoreChoice({ privy: null, dev: D }), "dev");
  assert.equal(restoreChoice({ privy: P, dev: D }), "ask-session");
  assert.equal(restoreChoice({ privy: P, dev: D, session: D.toUpperCase().replace("0X", "0x") }), "dev");
  assert.equal(restoreChoice({ privy: P, dev: D, session: P }), "privy");
  assert.equal(restoreChoice({ privy: P, dev: D, session: null }), "privy", "no session: Privy, the default sign-in");
});

test("CSP: nonce-based script policy, eval only in development", () => {
  const n = makeNonce();
  assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(makeNonce(), n);
  const prod = contentSecurityPolicy(n, { dev: false });
  const script = prod.split("; ").find((d) => d.startsWith("script-src "))!;
  assert.ok(script.includes(`'nonce-${n}'`) && script.includes("'strict-dynamic'"));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(prod));
  assert.match(prod, /object-src 'none'/);
  assert.match(prod, /base-uri 'self'/);
  assert.match(prod, /frame-ancestors 'none'/);
  assert.match(contentSecurityPolicy(n, { dev: true }), /'unsafe-eval'/);
  assert.throws(() => contentSecurityPolicy("x'; script-src *", { dev: false }));
});

test("unavailable-module stub: no exports enumerated, every named export throws", async () => {
  const { createRequire } = await import("node:module");
  const m = createRequire(import.meta.url)("../src/lib/wallet/unavailable-module.cjs") as Record<string, unknown>;
  assert.deepEqual(Object.keys(m), []);
  assert.deepEqual({ ...m }, {});
  assert.equal(m.then, undefined);
  assert.equal(m.__esModule, false);
  assert.equal(typeof Object.getOwnPropertyDescriptor(m, "anything")?.value, "function");
  assert.throws(() => (m.anything as () => void)(), /not available/);
});
