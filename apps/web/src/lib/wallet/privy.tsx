"use client";
// Privy: e-mail login + EVM embedded wallet on Tempo. Loaded only when NEXT_PUBLIC_PRIVY_APP_ID is set (next/dynamic in
// lib/wallet/index.tsx), so builds without Privy never ship its SDK. The PrivyProvider lives in a sibling branch of the
// app tree: only this bridge uses Privy's hooks, and it hands a `WalletSource` to the wallet provider via `onSource`.
//
// Signing: `toViemAccount({ wallet })` from `@privy-io/react-auth/tempo` (docs.privy.io/recipes/tempo/send-transactions)
// gives `sign({ hash })` (EIP-1193 `secp256k1_sign`, docs.privy.io/wallets/using-wallets/ethereum/sign-a-raw-hash) and
// `signMessage` (`personal_sign`). Transactions are serialized by our viem with the Tempo serializer and only their hash
// is signed by Privy (lib/wallet/account.ts), so the relay's fee-payer co-signature path is the same as the dev
// wallet's (test/wallet-send.test.ts).
import { PrivyProvider, useCreateWallet, useIdentityToken, useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { toViemAccount } from "@privy-io/react-auth/tempo";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAddress, type Address } from "viem";
import { ClientError } from "../error-map";
import { hashSignerAccount } from "./account";
import { BUILD_CHAIN_ID, privyChain } from "./privy-chain";
import type { WalletSource } from "./types";

type Pending = { resolve: (a: Address) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Longest sign-in (e-mail + code + wallet creation) before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** After login, wait for the embedded wallet to be created by `createOnLogin` before creating it explicitly. */
const CREATE_WALLET_AFTER_MS = 2500;

const isEmbedded = (w: ConnectedWallet) => w.walletClientType === "privy";

function Bridge({ onSource }: { onSource: (s: WalletSource) => void }) {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { identityToken } = useIdentityToken();
  const pending = useRef<Pending[]>([]);
  // A login asked for before the SDK was ready: the effect below opens it once `ready`.
  const wantLogin = useRef(false);
  const [tick, setTick] = useState(0);

  const settle = (fn: (p: Pending) => void) => {
    for (const p of pending.current.splice(0)) {
      clearTimeout(p.timer);
      fn(p);
    }
  };

  const { login } = useLogin({
    onError: (err) => {
      wantLogin.current = false;
      settle((p) => p.reject(new ClientError(err === "exited_auth_flow" ? "cancelled" : "login_failed", String(err))));
    },
  });

  // Hook functions change identity between renders: keep them in refs so effects and the source do not depend on them.
  const fns = useRef({ login, logout, createWallet });
  fns.current = { login, logout, createWallet };

  // The embedded wallet (e-mail login only, so it is the user's only EVM wallet).
  const embedded = useMemo(() => wallets.find(isEmbedded) ?? null, [wallets]);
  const walletRef = useRef(embedded);
  walletRef.current = embedded;
  const address = embedded ? (getAddress(embedded.address) as Address) : null;
  const tokenRef = useRef(identityToken);
  tokenRef.current = identityToken;

  // Resolves pending connects: opens the login when the SDK is ready, delivers the wallet when it appears and, when
  // the user is signed in without an embedded wallet, creates it.
  useEffect(() => {
    if (!ready || !pending.current.length) return;
    if (!authenticated) {
      if (wantLogin.current) {
        wantLogin.current = false;
        fns.current.login({ loginMethods: ["email"] });
      }
      return;
    }
    if (address) {
      settle((p) => p.resolve(address));
      return;
    }
    if (!walletsReady) return;
    const t = setTimeout(() => {
      if (walletRef.current || !pending.current.length) return;
      fns.current.createWallet().catch((e: unknown) => {
        if (!walletRef.current) settle((p) => p.reject(new ClientError("create_wallet_failed", (e as Error).message)));
      });
    }, CREATE_WALLET_AFTER_MS);
    return () => clearTimeout(t);
  }, [ready, walletsReady, authenticated, address, tick]);

  // Unmounted (e.g. a full page change): nobody waits forever.
  useEffect(() => () => settle((p) => p.reject(new ClientError("login_interrupted"))), []);

  const email = user?.email?.address ?? null;
  // Live state for the source's getters: a caller that holds an older source object (e.g. right after `connect()`
  // resolved, before React re-rendered the wallet provider) still reads the current address and e-mail.
  const state = useRef({ ready, authenticated, address, email });
  state.current = { ready, authenticated, address, email };

  useEffect(() => {
    onSource({
      kind: "privy",
      ready: ready && walletsReady,
      get address() {
        return state.current.authenticated ? state.current.address : null;
      },
      get email() {
        return state.current.authenticated ? state.current.email : null;
      },
      connect() {
        const s = state.current;
        if (s.authenticated && s.address) return Promise.resolve(s.address);
        return new Promise<Address>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.current = pending.current.filter((p) => p.timer !== timer);
            wantLogin.current = false;
            reject(new ClientError("login_timeout"));
          }, LOGIN_TIMEOUT_MS);
          pending.current.push({ resolve, reject, timer });
          if (!s.authenticated) {
            if (s.ready) fns.current.login({ loginMethods: ["email"] });
            else wantLogin.current = true;
          }
          setTick((n) => n + 1);
        });
      },
      async disconnect() {
        await fns.current.logout();
      },
      async account() {
        const w = walletRef.current;
        if (!w || !state.current.authenticated) throw new ClientError("wallet_not_connected");
        const privy = await toViemAccount({ wallet: w });
        const signRaw = privy.sign;
        if (!signRaw) throw new ClientError("wallet_not_connected");
        const expected = getAddress(w.address);
        return hashSignerAccount({
          address: expected,
          signHash: async (hash) => {
            // The wallet may have changed while the prompt was open: never sign for another address.
            if (!walletRef.current || getAddress(walletRef.current.address) !== expected) throw new ClientError("wallet_changed");
            return signRaw({ hash });
          },
          signMessage: (message) => privy.signMessage({ message }),
        });
      },
      async identityToken() {
        return tokenRef.current ?? null;
      },
    });
  }, [onSource, ready, walletsReady, authenticated, address, email]);

  return null;
}

export default function PrivyWallet({ appId, onSource }: { appId: string; onSource: (s: WalletSource) => void }) {
  // Configured once, before /api/config loads: the chain comes from the build (lib/wallet/privy-chain.ts); the wallet
  // provider refuses to sign with Privy if the API serves another chain.
  const chain = privyChain(BUILD_CHAIN_ID);
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        // https://docs.privy.io/basics/react/advanced/configuring-evm-networks
        supportedChains: [chain],
        defaultChain: chain,
        appearance: { walletChainType: "ethereum-only", theme: "light", accentColor: "#4A3CB0" },
        embeddedWallets: {
          // https://docs.privy.io/basics/react/advanced/automatic-wallet-creation
          ethereum: { createOnLogin: "users-without-wallets" },
          // The person already confirmed the action on our screen; the platform pays the network fee.
          // https://docs.privy.io/recipes/react/manage-wallet-UIs
          showWalletUIs: false,
        },
      }}
    >
      <Bridge onSource={onSource} />
    </PrivyProvider>
  );
}
