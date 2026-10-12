import type { NextConfig } from "next";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// next-intl finds the request config through the next-intl/config alias. The alias is set here instead of using the
// plugin (next-intl/plugin), which loads native @swc/core and @parcel/watcher only for the message extractor and breaks
// on Windows.
const I18N_REQUEST = "./src/i18n/request.ts";

// Same origin: the front calls /api/... with relative paths. In dev, Next rewrites the server routes to the local API;
// in production nginx does it.
const API_DEV = process.env.API_DEV_URL ?? "http://localhost:3018";
const PROXIED = ["/api", "/mcp", "/oauth", "/preview", "/.well-known", "/health"];

/**
 * X3 (docs/migration/decisions.md): @privy-io/react-auth references packages this app does not install (its optional
 * peers for other chains, and the HTTP-402 payment package removed by the workspace `overrides`). Privy imports them
 * only in flows this app never opens, but the bundler must resolve every import, so each package Privy declares and
 * that is NOT installed next to it is aliased to a module that throws if used. The list is computed from Privy's own
 * package.json, so a Privy upgrade cannot silently ship one of them.
 */
function privyMissingPackages(): string[] {
  try {
    // Privy's `exports` does not expose package.json: read it from the app's node_modules link.
    const pkgPath = path.join(realpathSync(path.resolve(import.meta.dirname, "node_modules", "@privy-io", "react-auth")), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    // pnpm links a package's dependencies as siblings of it: <store>/node_modules/@privy-io/react-auth -> <store>/node_modules/<dep>
    const siblings = path.resolve(path.dirname(pkgPath), "..", "..");
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
    // Installed next to Privy, in the app, or hoisted to the workspace root: resolvable, so not stubbed.
    const roots = [siblings, path.resolve(import.meta.dirname, "node_modules"), path.resolve(import.meta.dirname, "..", "..", "node_modules")];
    return names.filter((n) => !roots.some((r) => existsSync(path.join(r, n))));
  } catch {
    return [];
  }
}

const UNAVAILABLE = "./src/lib/wallet/unavailable-module.cjs";
const missing = privyMissingPackages();
const unavailableAliases = Object.fromEntries(missing.flatMap((n) => [[n, UNAVAILABLE], [`${n}/*`, UNAVAILABLE]]));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Subpath imports of the missing packages (`<name>/...`), for webpack (its plain alias would map them to `<stub>/...`). */
const missingSubpath = missing.length ? new RegExp(`^(?:${missing.map(escapeRe).join("|")})/`) : null;

// L3 (lib/wallet/privy-chain.ts): PrivyProvider gets its chain from the build. With Privy on and no chain id, the build
// silently targets the Moderato testnet and the app refuses Privy signatures on any other chain.
if (process.env.NEXT_PUBLIC_PRIVY_APP_ID && !process.env.NEXT_PUBLIC_CHAIN_ID) {
  console.warn(
    [
      "",
      "!!! NEXT_PUBLIC_PRIVY_APP_ID is set but NEXT_PUBLIC_CHAIN_ID is not.",
      "!!! Privy is configured for the Tempo Moderato testnet (42431); if the API serves another chain, e-mail wallets",
      "!!! will refuse to sign. Set NEXT_PUBLIC_CHAIN_ID to the API's chain id and rebuild.",
      "",
    ].join("\n"),
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@solvers/api-client", "@solvers/shared"],
  poweredByHeader: false,
  turbopack: { resolveAlias: { "next-intl/config": I18N_REQUEST, ...unavailableAliases } },
  webpack(config, { webpack }) {
    const unavailable = path.resolve(import.meta.dirname, UNAVAILABLE);
    config.resolve.alias = {
      ...config.resolve.alias,
      "next-intl/config": path.resolve(import.meta.dirname, I18N_REQUEST),
      // `name$` matches the bare package only; subpaths are replaced by the plugin below.
      ...Object.fromEntries(missing.map((n) => [`${n}$`, unavailable])),
    };
    if (missingSubpath) {
      config.plugins = [...(config.plugins ?? []), new webpack.NormalModuleReplacementPlugin(missingSubpath, unavailable)];
    }
    return config;
  },
  async headers() {
    // The Content-Security-Policy (script-src with a per-request nonce, frame-ancestors 'none') is sent by src/proxy.ts
    // on every page: a nonce cannot be static (lib/csp.ts). Here: X-Frame-Options for older browsers on the connector
    // consent screen, package review (/admin) and the creator area (/creator), which show third-party content and
    // powerful actions (approve, co-sign). Headers are only ADDED here; nothing loosens a header the app already sends.
    // Creator content is always escaped text, never HTML (components/admin/ReviewDetail.tsx).
    const guarded = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ];
    // Each area exists without a prefix (English) and with /pt.
    const both = (p: string) => [p, `/pt${p}`];
    return [
      ...both("/connect").map((source) => ({
        source,
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      })),
      ...both("/admin/:path*").map((source) => ({ source, headers: [...guarded, { key: "Cache-Control", value: "no-store" }] })),
      ...both("/creator/:path*").map((source) => ({ source, headers: guarded })),
    ];
  },
  async redirects() {
    // Old Portuguese routes (links already shared): 301 to the new ones, keeping Portuguese.
    const OLD: [string, string][] = [
      ["/especialistas/:slug", "/solvers/:slug"],
      ["/biblioteca/memorias", "/library/memories"],
      ["/biblioteca", "/library"],
      ["/checkout/concluido", "/checkout/done"],
      ["/conectar", "/connect"],
      ["/criador/envios/:id", "/creator/submissions/:id"],
      ["/criador/envios", "/creator/submissions"],
      ["/criador/publicar", "/creator/publish"],
      ["/criador", "/creator"],
      ["/criadores/:id", "/creators/:id"],
      ["/garantias", "/guarantees"],
      ["/instalar", "/install"],
      ["/perfil", "/profile"],
      ["/admin/revisoes/:id", "/admin/reviews/:id"],
      ["/admin/revisoes", "/admin/reviews"],
    ];
    return OLD.flatMap(([from, to]) => [
      { source: from, destination: `/pt${to}`, permanent: true },
      { source: `/pt${from}`, destination: `/pt${to}`, permanent: true },
    ]);
  },
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    return PROXIED.flatMap((p) => [
      { source: p, destination: `${API_DEV}${p}` },
      { source: `${p}/:path*`, destination: `${API_DEV}${p}/:path*` },
    ]);
  },
};

export default nextConfig;
