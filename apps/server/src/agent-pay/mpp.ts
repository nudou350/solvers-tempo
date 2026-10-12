import { fromUnits } from "@solvers/shared";
import type { RequestHandler } from "express";
import { Challenge } from "mppx";
import { Mppx, tempo } from "mppx/express";

import { chainContext } from "../chain/index.js";
import { env } from "../env.js";
import { expiresAtOf, payloadOf, type LedgerRow } from "../payments/ledger.js";
import type { AgentPayProvider } from "./provider.js";

// The MPP server (`mppx/express`, `tempo` method, `charge` intent; https://tempo.xyz/developers/docs/guide/machine-payments/server).
// - recipient: the PLATFORM float (see provider.ts for why);
// - feePayer: the RELAY key co-signs pull-mode payments, so the agent pays no network fee (D3, D11);
// - every challenge carries `externalId` = our order id and expires with the order; `onChallengeCreated` records its id
//   (the memo of the payment is bound to it) and `onPaymentSuccess` records the settlement tx before the route fulfils.
// mppx's replay protection (in-memory store, one API process) only covers transaction hashes and its challenges are
// stateless; one payment per order is enforced by the order itself (`claimOrder` before the broadcast, duplicate
// settlements refunded by `markSettled`, see provider.ts).

type Instance = ReturnType<typeof create>;

let instance: Instance | null = null;
let provider: AgentPayProvider | null = null;

function create(p: AgentPayProvider) {
  const c = chainContext();
  const mppx = Mppx.create({
    secretKey: env.MPP_SECRET_KEY!,
    realm: env.MPP_REALM ?? new URL(env.PUBLIC_API_URL).host,
    methods: [
      tempo.charge({
        currency: env.PAYMENT_TOKEN,
        decimals: env.PAYMENT_TOKEN_DECIMALS,
        recipient: c.accounts.platform.address,
        feePayer: c.accounts.relay,
        feeToken: env.PAYMENT_TOKEN,
        allowedFeeTokens: [env.PAYMENT_TOKEN],
        chainId: env.CHAIN_ID,
        getClient: () => c.publicClient as never,
      }),
    ],
  });
  mppx.onChallengeCreated(async (ctx) => {
    const id = (ctx.request as { externalId?: string }).externalId;
    if (id) await p.recordChallenge(id, ctx.challenge.id);
  });
  mppx.onPaymentSuccess(async (ctx) => {
    const id = (ctx.request as { externalId?: string }).externalId;
    if (id) await p.markSettled(id, ctx.receipt.reference);
  });
  return mppx;
}

export function initMpp(p: AgentPayProvider): void {
  provider = p;
  instance = null;
}

function mpp(): Instance {
  if (!provider) throw new Error("agent-pay: initMpp() was not called");
  if (!instance) instance = create(provider);
  return instance;
}

/** Whether a challenge echoed in a credential was issued by this server (HMAC over all its fields, mppx `Challenge.verify`). */
export function challengeIssuedHere(challenge: Challenge.Challenge): boolean {
  try {
    return Challenge.verify(challenge, { secretKey: env.MPP_SECRET_KEY! });
  } catch {
    return false;
  }
}

/**
 * Express middleware charging exactly the order's amount, bound to the order id and its expiry. The description is the
 * one stored when the order was opened: mppx's charge binding includes it, so a live value (the Solver's current name)
 * would make every credential of an order fail after a rename.
 */
export function chargeOrder(row: LedgerRow): RequestHandler {
  const expires = expiresAtOf(row) ?? new Date(Date.now() + env.AGENT_PAY_ORDER_TTL_SECS * 1000);
  const description = payloadOf(row).description;
  return mpp().charge({
    amount: fromUnits(row.tokenAmount, env.PAYMENT_TOKEN_DECIMALS),
    externalId: row.id,
    ...(typeof description === "string" ? { description } : {}),
    expires: expires.toISOString(),
  });
}
