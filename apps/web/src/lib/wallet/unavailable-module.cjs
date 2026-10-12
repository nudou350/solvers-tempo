// Stand-in for the optional packages of @privy-io/react-auth that this app does not install (other chains' SDKs and
// Privy's HTTP-402 payment hook; see next.config.ts and docs/migration/decisions.md X3). Privy only loads them in
// flows this app never opens (non-EVM wallets, its 402 fetch hook). Any use throws a clear error instead of failing
// the build. CommonJS on purpose: bundlers do not check named imports against a CommonJS module.
"use strict";

function unavailable() {
  throw new Error("This wallet feature is not available in Solvers (EVM embedded wallet only).");
}

/** Keys that must not look like exports: interop checks (`__esModule`) and thenable detection (`then`). */
const NOT_EXPORTS = new Set(["__esModule", "then"]);

module.exports = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === "__esModule") return false;
      if (NOT_EXPORTS.has(key)) return undefined; // not a thenable (dynamic import() resolves to the module itself)
      return unavailable;
    },
    // Consistent with `get` for bundler interop helpers that enumerate or describe the exports (e.g. a namespace
    // import copying own keys): no enumerable exports, and any named export described as the throwing stub.
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== "string" || NOT_EXPORTS.has(key)) return undefined;
      return { configurable: true, enumerable: false, writable: false, value: unavailable };
    },
    has(_target, key) {
      return typeof key === "string" && !NOT_EXPORTS.has(key);
    },
  },
);
