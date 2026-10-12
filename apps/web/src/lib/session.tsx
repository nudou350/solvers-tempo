"use client";
// Session of the web app: Sign-In with Ethereum (EIP-4361) through the api-client (`/api/auth/nonce` +
// `/api/auth/verify`), an httpOnly session cookie set by the server, and, with Privy, the e-mail link
// (`/api/auth/privy/link` with the Privy identity token) so the free trial is counted per person.
// `useSession()` in signed-in screens; `useWallet()` (lib/wallet) for signatures and transactions.
import type { PublicConfig } from "@solvers/api-client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { API_BASE, api, ApiError, onUnauthorized, type SolversApi } from "./api";
import { usePublicConfig } from "./config";
import { ClientError } from "./error-map";
import { useWallet, type WalletKind } from "./wallet";

export type SessionStatus = "loading" | "signed-out" | "signed-in";

/** The signed-in person: the session wallet plus name and e-mail from the profile. */
export type Me = { wallet: Address; displayName: string | null; email: string | null };

export type Session = {
  status: SessionStatus;
  /** Wallet of the server session (lowercase), or null when signed out. */
  wallet: Address | null;
  /**
   * Connects the wallet if needed (Privy e-mail login or the dev wallet) and signs the SIWE message. Rejects with a
   * friendly error (lib/error-text) when the person cancels or the server refuses. `kind` picks the wallet explicitly.
   */
  signIn(kind?: WalletKind): Promise<void>;
  /** Ends the server session and disconnects the wallet (the dev wallet key stays in this browser). */
  signOut(): Promise<void>;
  /** Profile data of the signed-in person (null while loading or signed out). */
  me: Me | null;
  /** True while a sign-in is in progress. */
  signingIn: boolean;
  /** Re-reads /api/auth/me and the profile (e.g. after editing the name). */
  refresh(): Promise<Me | null>;
  /** The API client (same instance as lib/api). */
  api: SolversApi;
  /** Public config (`GET /api/config`), null while it loads. Same as `usePublicConfig()`. */
  config: PublicConfig | null;
};

const Ctx = createContext<Session | null>(null);

// Session hint. The cookie is httpOnly (JS cannot see it), so without a hint /api/auth/me would just answer 401.
// - HINT (localStorage): this site opened a session and has not signed out.
// - CHECKED (sessionStorage): this tab already asked the server once. Without HINT it asks once per tab, to still
//   notice a session opened elsewhere (e.g. the connector consent page).
const HINT = "solvers.session.v1";
const CHECKED = "solvers.sessionChecked.v1";

function shouldAskServer(): boolean {
  try {
    if (localStorage.getItem(HINT)) return true;
    if (sessionStorage.getItem(CHECKED)) return false;
    sessionStorage.setItem(CHECKED, "1");
    return true;
  } catch {
    return true;
  }
}

function setHint(on: boolean) {
  try {
    if (on) localStorage.setItem(HINT, "1");
    else localStorage.removeItem(HINT);
  } catch {
    // no storage: always ask
  }
}

async function fetchMe(): Promise<Me | null> {
  try {
    const { wallet } = await api.me();
    const profile = await api.getProfile().catch(() => null);
    setHint(true);
    return { wallet, displayName: profile?.displayName ?? null, email: profile?.email ?? null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setHint(false);
      return null;
    }
    throw e;
  }
}

/** Links the Privy e-mail to the session wallet (free trial per person). Best effort: a failure never blocks sign-in. */
async function linkPrivy(identityToken: string): Promise<void> {
  await fetch(`${API_BASE}/api/auth/privy/link`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken }),
  }).catch(() => undefined);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const config = usePublicConfig();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  /** Re-reads the session. Without `force`, skips the server when there is no session hint (see HINT). */
  const refresh = useCallback(async (force = true) => {
    if (!force && !shouldAskServer()) {
      setMe(null);
      setStatus("signed-out");
      return null;
    }
    try {
      const m = await fetchMe();
      setMe(m);
      setStatus(m ? "signed-in" : "signed-out");
      return m;
    } catch {
      setStatus((s) => (s === "loading" ? "signed-out" : s));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // 401 in the middle of a session (cookie expired): re-read it; the status becomes "signed-out" and screens ask to sign in.
  const statusRef = useRef(status);
  statusRef.current = status;
  const rechecking = useRef(false);
  useEffect(
    () =>
      onUnauthorized(() => {
        if (statusRef.current !== "signed-in" || rechecking.current) return;
        rechecking.current = true;
        void refresh().finally(() => {
          rechecking.current = false;
        });
      }),
    [refresh],
  );

  const inflight = useRef<Promise<void> | null>(null);
  const signIn = useCallback((kind?: WalletKind) => {
    inflight.current ??= (async () => {
      setSigningIn(true);
      try {
        // Always through connect(): it reads the wallet's live state (resolving at once when that wallet is connected).
        // The hook value in walletRef may be from before a disconnect or a forgotten dev key and must not decide.
        const w = walletRef.current;
        const address = await w.connect(kind);
        // The wallet functions read live state too, so they are safe on this possibly older value.
        await api.login({ address, signMessage: (m) => w.signMessage(m), sendCalls: (calls) => w.sendCalls(calls) });
        const token = await w.identityToken().catch(() => null);
        if (token) await linkPrivy(token);
        let m = await fetchMe();
        if (!m) throw new ClientError("session_not_created");
        // The e-mail from the source connected now (the first Privy login has no e-mail in the earlier snapshot).
        const email = w.liveEmail();
        if (email && !m.email) {
          const saved = await api.updateProfile({ email }).then(
            () => true,
            () => false,
          );
          if (saved) m = { ...m, email };
        }
        setMe(m);
        setStatus("signed-in");
      } finally {
        setSigningIn(false);
        inflight.current = null;
      }
    })();
    return inflight.current;
  }, []);

  const signOut = useCallback(async () => {
    setHint(false);
    await api.logout().catch(() => undefined);
    await walletRef.current.disconnect().catch(() => undefined);
    setMe(null);
    setStatus("signed-out");
  }, []);

  const value = useMemo<Session>(
    () => ({ status, wallet: me?.wallet ?? null, signIn, signOut, me, signingIn, refresh: () => refresh(true), api, config }),
    [status, me, signIn, signOut, signingIn, refresh, config],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession must be used inside <SessionProvider>");
  return s;
}
