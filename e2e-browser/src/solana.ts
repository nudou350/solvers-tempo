// Solana side of the USDC checkout: decode the QR image shown by the page, pay it from the devnet test payer (the
// scripts' wallet-like transfer), and verify the confirmed transaction (reference, amount to the recipient, memo).
import "./env.js";
import type { Locator } from "@playwright/test";
import { address, type Signature } from "@solana/kit";
import jsQRModule, { type QRCode } from "jsqr";
import { assertDevnet, ata, loadPayer, payTransferRequest, solBalance, solanaRpc, splBalance, toUnits, parseSolanaPayUrl, type PayResult } from "../../scripts/src/lib/solana.js";

// jsqr is CommonJS with `exports.default`: depending on the loader the default import is the function or the module.
type Decode = (data: Uint8ClampedArray, width: number, height: number) => QRCode | null;
const jsQRAny = jsQRModule as unknown as Decode & { default?: Decode };
const jsQR: Decode = typeof jsQRAny.default === "function" ? jsQRAny.default : jsQRAny;

export { assertDevnet, loadPayer, parseSolanaPayUrl, solBalance, splBalance, toUnits };

/**
 * Decodes the QR code of an <img> on the page: the image is drawn on a canvas in the page (its pixels, not its
 * src attribute) and the pixels are decoded here with jsQR.
 */
export async function decodeQrImage(img: Locator): Promise<string> {
  const px = await img.evaluate(async (el: HTMLImageElement) => {
    if (!el.complete || el.naturalWidth === 0) {
      await new Promise<void>((ok, fail) => {
        el.addEventListener("load", () => ok(), { once: true });
        el.addEventListener("error", () => fail(new Error("the QR image failed to load")), { once: true });
        setTimeout(() => fail(new Error("the QR image did not load in 15 s")), 15_000);
      });
    }
    const c = document.createElement("canvas");
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
  const code = jsQR(Uint8ClampedArray.from(px.data), px.w, px.h);
  if (!code) throw new Error(`no QR code found in the ${px.w}x${px.h} image`);
  return code.data;
}

/** Pays a Solana Pay URL from the test payer exactly like scripts/src/solana-pay-url.ts (devnet only). */
export async function payFromTestPayer(url: string): Promise<PayResult> {
  await assertDevnet();
  return payTransferRequest(await loadPayer(), url);
}

export type SolanaTxFacts = { ok: boolean; accountKeys: string[]; memos: string[]; recipientDelta: bigint; payerDelta: bigint };

/**
 * Facts of a confirmed Solana transaction from its own metadata (not from balances read later): success, account keys,
 * the memo instructions, and the USDC change of the recipient's and the payer's token accounts.
 */
export async function solanaTxFacts(sig: string, o: { recipient: string; payer: string; mint: string }): Promise<SolanaTxFacts> {
  // RPC nodes behind a load balancer may not serve a just-confirmed transaction yet: retry for a while.
  let tx = null;
  for (let i = 0; i < 15 && !tx; i++) {
    tx = await solanaRpc().getTransaction(sig as Signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
    if (!tx) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!tx) throw new Error(`Solana transaction ${sig} not found after 30 s`);
  const accountKeys = tx.transaction.message.accountKeys.map((k) => String(k.pubkey));
  const memos = tx.transaction.message.instructions
    .filter((i) => "program" in i && i.program === "spl-memo")
    .map((i) => String((i as { parsed: unknown }).parsed));
  const amount = (list: readonly { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] | null | undefined, owner: string) =>
    BigInt(list?.find((b) => b.owner === owner && b.mint === o.mint)?.uiTokenAmount.amount ?? "0");
  const pre = tx.meta?.preTokenBalances as never;
  const post = tx.meta?.postTokenBalances as never;
  return {
    ok: tx.meta?.err === null,
    accountKeys,
    memos,
    recipientDelta: amount(post, o.recipient) - amount(pre, o.recipient),
    payerDelta: amount(post, o.payer) - amount(pre, o.payer),
  };
}

/** Associated token account of `owner` for `mint`. */
export const tokenAccountOf = (owner: string, mint: string) => ata(address(owner), address(mint));
