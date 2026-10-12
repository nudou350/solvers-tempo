"use client";
// Wallet layer of the web app: `WalletProvider` (Privy when NEXT_PUBLIC_PRIVY_APP_ID is set, plus the dev wallet when
// NEXT_PUBLIC_ALLOW_DEV_WALLET=1 and the network is not mainnet) and `useWallet()`. Every signature and every
// transaction of the app goes through `useWallet()`; transactions are ONE Tempo 0x76 batch sponsored by the platform
// relay (lib/wallet/send.ts).
import type { Call } from "@solvers/shared";
import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address, Hex, LocalAccount } from "viem";
import { api, relayUrl } from "../api";
import { loadPublicConfig, loadServerClock } from "../config-cache";
import { ClientError } from "../error-map";
import { DEV_WALLET_ENABLED, devWalletBlockHere, forgetDevKey, loadDevAccount } from "./dev";
import { BUILD_CHAIN_ID, privyChainMismatch } from "./privy-chain";
import { restoreChoice } from "./restore";
import { sendSponsoredCalls } from "./send";
import type { Wallet, WalletKind, WalletSource } from "./types";

export type { Wallet, WalletKind, WalletStatus } from "./types";
export { devWalletBlock, devWalletBlockHere, DEV_WALLET_ENABLED } from "./dev";
export { SponsorDeclinedError } from "./send";

/** Privy app id (build time). Without it, only the dev wallet can be offered. */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || null;

const PrivyWallet = dynamic(() => import("./privy"), { ssr: false });

const Ctx = createContext<Wallet | null>(null);

/**
 * Dev wallet source over a viem local account kept in localStorage. Reads and writes the account through a ref, so a
 * signature right after `connect()` (same tick, before React re-renders) already sees the new account.
 */
function devSource(ref: { current: LocalAccount | null }, set: (a: LocalAccount | null) => void): WalletSource {
  const put = (a: LocalAccount | null) => {
    ref.current = a;
    set(a);
  };
  return {
    kind: "dev",
    ready: true,
    get address() {
      return ref.current?.address ?? null;
    },
    email: null,
    async connect() {
      const config = await loadPublicConfig().catch(() => null);
      const block = devWalletBlockHere(config?.chainId ?? null);
      if (block) throw new ClientError(block === "mainnet" ? "dev_wallet_mainnet" : block === "not-enabled" ? "dev_wallet_disabled" : "network_unknown");
      const a = ref.current ?? loadDevAccount(true);
      if (!a) throw new ClientError("dev_wallet_disabled");
      put(a);
      return a.address;
    },
    // Signing out keeps the key: the same browser comes back to the same wallet (and the same licenses).
    async disconnect() {
      put(null);
    },
    async account() {
      if (!ref.current) throw new ClientError("wallet_not_connected");
      return ref.current;
    },
    async identityToken() {
      return null;
    },
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [devAccount, setDevAccount] = useState<LocalAccount | null>(null);
  const devRef = useRef<LocalAccount | null>(null);
  const [devChecked, setDevChecked] = useState(!DEV_WALLET_ENABLED);
  const [privy, setPrivy] = useState<WalletSource | null>(null);
  // Which source the person connected with (both may be available on a testnet build). The ref is read by the
  // signing functions, which may run right after `connect()` and before the next render.
  const [active, setActive] = useState<WalletKind | null>(null);
  const activeRef = useRef<WalletKind | null>(null);
  const activate = (k: WalletKind | null) => {
    activeRef.current = k;
    setActive(k);
  };

  // Restore the dev wallet only after the API confirms a non-mainnet network (in doubt, do not restore). It is only a
  // candidate here: the restore decision below picks between it and a restored Privy session.
  const [devRestored, setDevRestored] = useState<LocalAccount | null>(null);
  useEffect(() => {
    if (!DEV_WALLET_ENABLED) return;
    let alive = true;
    loadPublicConfig()
      .then((c) => {
        if (!alive || devWalletBlockHere(c.chainId)) return;
        setDevRestored(loadDevAccount(false));
      })
      .catch(() => {})
      .finally(() => alive && setDevChecked(true));
    return () => {
      alive = false;
    };
  }, []);

  // Restore decision, once both sources are known: one restored source wins; with both (a testnet build with Privy and a
  // dev key in this browser), the one whose address is the server session's wallet wins (lib/wallet/restore.ts).
  const restored = useRef(false);
  const privyReady = PRIVY_APP_ID === null || !!privy?.ready;
  const privyRestored = privy?.address ?? null;
  useEffect(() => {
    if (restored.current || activeRef.current !== null || !devChecked || !privyReady) return;
    const pick = (k: WalletKind | null) => {
      if (!k || activeRef.current !== null) return;
      if (k === "dev") {
        if (!devRestored) return;
        devRef.current = devRestored;
        setDevAccount(devRestored);
      }
      activate(k);
    };
    const first = restoreChoice({ privy: privyRestored, dev: devRestored?.address ?? null });
    if (first === null) return; // nothing to restore yet (a Privy session may still appear)
    restored.current = true;
    if (first !== "ask-session") return pick(first);
    api.me().then(
      ({ wallet }) => pick(restoreChoice({ privy: privyRestored, dev: devRestored?.address ?? null, session: wallet }) as WalletKind),
      () => pick(restoreChoice({ privy: privyRestored, dev: devRestored?.address ?? null, session: null }) as WalletKind),
    );
  }, [devChecked, privyReady, privyRestored, devRestored]);

  const dev = useMemo(() => (DEV_WALLET_ENABLED ? devSource(devRef, setDevAccount) : null), []);
  const current: WalletSource | null = active === "privy" ? privy : active === "dev" ? dev : null;
  const sources = useRef({ privy, dev });
  sources.current = { privy, dev };
  const liveSource = (): WalletSource | null =>
    activeRef.current === "privy" ? sources.current.privy : activeRef.current === "dev" ? sources.current.dev : null;

  const loading = (PRIVY_APP_ID !== null && !privy?.ready) || !devChecked;
  // devAccount is read here so a dev connect/disconnect re-renders with the new address.
  const address = ((active === "dev" ? devAccount?.address : current?.address) ?? null) as Address | null;
  const status: Wallet["status"] = address ? "connected" : loading ? "loading" : "disconnected";

  /**
   * Privy is configured from the build's chain (lib/wallet/privy-chain.ts): when the API serves another chain, refuse to
   * sign with it (logged loudly; a wrong build must not produce signatures for the wrong network).
   */
  const assertPrivyChain = async (src: WalletSource) => {
    if (src.kind !== "privy") return;
    const config = await loadPublicConfig();
    const mismatch = privyChainMismatch(BUILD_CHAIN_ID, config.chainId);
    if (mismatch) {
      console.error(`[solvers] Privy is configured for chain ${mismatch.privy} but the API serves chain ${mismatch.api}; set NEXT_PUBLIC_CHAIN_ID and rebuild.`);
      throw new ClientError("privy_chain_mismatch", undefined, { ...mismatch });
    }
  };

  // Reads live state (refs), so a caller holding an older `Wallet` value still connects the current source. Without
  // `kind`, the active source when it is connected, else the default (Privy when configured). A connected source
  // resolves at once with its address.
  const connect = useCallback(async (kind?: WalletKind) => {
    const live = liveSource();
    const want: WalletKind = kind ?? (live?.address ? live.kind : PRIVY_APP_ID ? "privy" : "dev");
    const src = want === "privy" ? sources.current.privy : sources.current.dev;
    if (!src) throw new ClientError(want === "privy" ? (PRIVY_APP_ID ? "login_loading" : "privy_not_configured") : "dev_wallet_disabled");
    const address = await src.connect();
    activate(want);
    return address;
  }, []);

  const disconnect = useCallback(async () => {
    const src = liveSource();
    activate(null);
    await src?.disconnect();
  }, []);

  // The source's account() checks that it is still connected (Privy reads its live wallet, the dev source its ref).
  const requireCurrent = () => {
    const src = liveSource();
    if (!src) throw new ClientError("wallet_not_connected");
    return src;
  };

  const signMessage = useCallback(async (message: string): Promise<Hex> => {
    const src = requireCurrent();
    await assertPrivyChain(src);
    const account = await src.account();
    return account.signMessage({ message });
  }, []);

  const sendCalls = useCallback(async (calls: readonly Call[]): Promise<Hex> => {
    const src = requireCurrent();
    const config = await loadPublicConfig();
    if (src.kind === "dev" && devWalletBlockHere(config.chainId)) throw new ClientError("dev_wallet_mainnet");
    await assertPrivyChain(src);
    const account = await src.account();
    // validBefore on the server's clock (the relay's), offset measured once per page load, never this device's alone.
    const nowSecs = await loadServerClock();
    return sendSponsoredCalls({ account, chainId: config.chainId, rpcUrl: config.rpcUrl, relayUrl: relayUrl(), calls, nowSecs });
  }, []);

  const identityToken = useCallback(async () => (await liveSource()?.identityToken()) ?? null, []);
  const liveEmail = useCallback(() => liveSource()?.email ?? null, []);

  const forgetDevWallet = useCallback(() => {
    forgetDevKey();
    devRef.current = null;
    setDevRestored(null);
    setDevAccount(null);
    if (activeRef.current === "dev") activate(null);
  }, []);

  const value = useMemo<Wallet>(
    () => ({
      status,
      address,
      kind: address ? (current?.kind ?? null) : null,
      connect,
      disconnect,
      signMessage,
      sendCalls,
      available: { privy: PRIVY_APP_ID !== null, dev: DEV_WALLET_ENABLED },
      email: current?.email ?? null,
      identityToken,
      liveEmail,
      forgetDevWallet,
    }),
    [status, address, current?.kind, current?.email, connect, disconnect, signMessage, sendCalls, identityToken, liveEmail, forgetDevWallet],
  );

  return (
    <Ctx.Provider value={value}>
      {PRIVY_APP_ID ? <PrivyWallet appId={PRIVY_APP_ID} onSource={setPrivy} /> : null}
      {children}
    </Ctx.Provider>
  );
}

export function useWallet(): Wallet {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWallet must be used inside <WalletProvider>");
  return w;
}
