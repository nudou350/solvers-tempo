// Pure rules of the relay and of the server nonce lanes: quota keys and limits, broadcast error classification, and the
// raw-transaction sponsorship check. No env, database or chain.
import "./helpers/fake-env.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { requestsSponsorship } from "@solvers/chain";
import { HttpRequestError, InvalidInputRpcError, RpcRequestError, TransactionReceiptNotFoundError } from "viem";

import { GLOBAL_QUOTA_REFUSAL, quotaIpKey, quotaRefusal } from "../src/relay/rules.js";
import { isDefinitiveRejection, isReceiptNotFound } from "../src/chain/lanes.js";

describe("relay quota keys", () => {
  it("IPv4 (also IPv4-mapped) is the address; IPv6 is its /64", () => {
    assert.equal(quotaIpKey("203.0.113.9"), "203.0.113.9");
    assert.equal(quotaIpKey("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(quotaIpKey("2001:db8:aaaa:bbbb:1:2:3:4"), "2001:db8:aaaa:bbbb::/64");
    assert.equal(quotaIpKey("2001:db8:aaaa:bbbb::1"), "2001:db8:aaaa:bbbb::/64", "rotating the interface id keeps the key");
    assert.equal(quotaIpKey("2001:DB8:0:0001::7"), "2001:db8:0:1::/64");
    assert.equal(quotaIpKey("::1"), "0:0:0:0::/64");
    assert.equal(quotaIpKey(undefined), null);
  });
});

describe("relay quotas", () => {
  const l = { dailyGasPerWallet: 100n, dailyGasPerIp: 300n, dailyGasGlobal: 1000n };
  it("wallet, then network, then the global budget", () => {
    assert.equal(quotaRefusal(10n, { wallet: 0n, ip: 0n, global: 0n }, l), null);
    assert.match(quotaRefusal(10n, { wallet: 95n, ip: 0n, global: 0n }, l)!, /wallet/);
    assert.match(quotaRefusal(10n, { wallet: 0n, ip: 295n, global: 0n }, l)!, /network address/);
    assert.equal(quotaRefusal(10n, { wallet: 0n, ip: null, global: 995n }, l), GLOBAL_QUOTA_REFUSAL);
    assert.equal(quotaRefusal(10n, { wallet: 90n, ip: 290n, global: 990n }, l), null, "exactly at the limits is allowed");
  });
});

describe("server broadcast errors", () => {
  it("a JSON-RPC rejection is definitive; transport failures are ambiguous", () => {
    const rpc = new RpcRequestError({ body: {}, url: "http://rpc", error: { code: -32000, message: "nonce too low" } });
    assert.equal(isDefinitiveRejection(new InvalidInputRpcError(rpc)), true);
    assert.equal(isDefinitiveRejection(new HttpRequestError({ url: "http://rpc", details: "fetch failed" })), false);
    const wrapped = Object.assign(new Error("send failed"), { cause: new HttpRequestError({ url: "http://rpc", status: 502 }) });
    assert.equal(isDefinitiveRejection(wrapped), false);
    assert.equal(isDefinitiveRejection(new Error("unknown")), false, "unknown errors are treated as ambiguous");
  });

  it("only TransactionReceiptNotFoundError means the node has no receipt", () => {
    assert.equal(isReceiptNotFound(new TransactionReceiptNotFoundError({ hash: `0x${"1".repeat(64)}` })), true);
    assert.equal(isReceiptNotFound(new HttpRequestError({ url: "http://rpc", status: 503 })), false);
  });
});

describe("relay raw transactions", () => {
  it("only Tempo transactions asking for sponsorship pass", () => {
    assert.equal(requestsSponsorship(["0x02f86c0180808080808080c0"]), false, "an EIP-1559 transaction is not sponsorable");
    assert.equal(requestsSponsorship(["0x76deadbeef"]), false, "malformed");
    assert.equal(requestsSponsorship([]), false);
    assert.equal(requestsSponsorship(undefined), false);
  });
});
