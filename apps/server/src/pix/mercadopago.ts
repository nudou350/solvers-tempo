import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { HttpError } from "../lib/http.js";

// Mercado Pago, Orders API (Pix). Plain fetch, no SDK.
// Docs: developers.mercadopago.com > Checkout API (Orders) > Pix, order status, refunds and notifications.

const BASE = "https://api.mercadopago.com";

export type MpOrder = {
  id: string;
  status: string; // action_required | processing | processed | expired | canceled | failed | refunded | charged_back
  status_detail?: string;
  external_reference?: string;
  total_amount?: string;
  transactions?: {
    payments?: {
      id?: string;
      status?: string;
      expiration_time?: string;
      date_of_expiration?: string;
      payment_method?: { id?: string; type?: string; qr_code?: string; qr_code_base64?: string; ticket_url?: string };
    }[];
  };
};

async function mp<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  if (!env.MP_ACCESS_TOKEN) throw new HttpError(503, "Mercado Pago is not configured", "pix_unavailable");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      "content-type": "application/json",
      ...(init.idempotencyKey ? { "x-idempotency-key": init.idempotencyKey } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; errors?: unknown };
  if (!res.ok) {
    console.error("[mercadopago]", init.method ?? "GET", path, res.status, JSON.stringify(body).slice(0, 500));
    throw new HttpError(502, "Mercado Pago declined the request. Please try again in a moment.", "pix_provider_error");
  }
  return body;
}

const brl = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;

export function createPixOrder(input: { externalReference: string; amountCents: bigint; email: string; firstName: string }) {
  const amount = brl(input.amountCents);
  return mp<MpOrder>("/v1/orders", {
    method: "POST",
    idempotencyKey: input.externalReference,
    body: JSON.stringify({
      type: "online",
      external_reference: input.externalReference,
      total_amount: amount,
      processing_mode: "automatic",
      transactions: {
        payments: [{ amount, payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: "PT30M" }],
      },
      // In test mode, first_name "APRO" makes the Pix approve on its own.
      payer: { email: input.email, first_name: env.MP_TEST_MODE ? "APRO" : input.firstName },
    }),
  });
}

export const getOrder = (id: string) => mp<MpOrder>(`/v1/orders/${encodeURIComponent(id)}`);

/** Full refund of a processed order. The idempotency key makes a retried refund (after a crash) a no-op. */
export const refundOrder = (id: string, idempotencyKey: string) =>
  mp<MpOrder>(`/v1/orders/${encodeURIComponent(id)}/refund`, { method: "POST", idempotencyKey });

/** Cancels an unpaid order so it can no longer be paid after we expired the charge. */
export const cancelOrder = (id: string, idempotencyKey: string) =>
  mp<MpOrder>(`/v1/orders/${encodeURIComponent(id)}/cancel`, { method: "POST", idempotencyKey });

export function orderPayment(order: MpOrder) {
  const p = order.transactions?.payments?.[0];
  return {
    qrCode: p?.payment_method?.qr_code ?? null,
    qrBase64: p?.payment_method?.qr_code_base64 ?? null,
    ticketUrl: p?.payment_method?.ticket_url ?? null,
  };
}

/** A signed notification older (or further in the future) than this is refused: a captured one cannot be replayed later. */
export const WEBHOOK_MAX_AGE_MS = 10 * 60_000;

/** `ts` of the signature as epoch ms (Mercado Pago has sent both seconds and milliseconds). */
export function webhookTsMs(ts: string): number | null {
  if (!/^\d{9,14}$/.test(ts)) return null;
  const n = Number(ts);
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Verifies the x-signature header ("ts=...,v1=...") of a Mercado Pago webhook.
 * Manifest: "id:<lowercase data.id>;request-id:<x-request-id>;ts:<ts>;" (missing pairs are omitted),
 * HMAC-SHA256 in hex with MP_WEBHOOK_SECRET, compared in constant time. `ts` must be within WEBHOOK_MAX_AGE_MS of now.
 */
export function verifyWebhookSignature(opts: {
  signature: string | undefined;
  requestId: string | undefined;
  dataId: string | undefined;
  secret: string | undefined;
  now?: number;
}): boolean {
  if (!opts.secret || !opts.signature) return false;
  const parts = new Map(
    opts.signature.split(",").map((kv) => {
      const [k, ...v] = kv.split("=");
      return [k!.trim(), v.join("=").trim()] as const;
    }),
  );
  const ts = parts.get("ts");
  const v1 = parts.get("v1");
  if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const at = webhookTsMs(ts);
  if (at === null || Math.abs((opts.now ?? Date.now()) - at) > WEBHOOK_MAX_AGE_MS) return false;
  let manifest = "";
  if (opts.dataId) manifest += `id:${opts.dataId.toLowerCase()};`;
  if (opts.requestId) manifest += `request-id:${opts.requestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac("sha256", opts.secret).update(manifest).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex"));
}
