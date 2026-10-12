// Site admin = a wallet listed in ADMIN_WALLETS (comma separated), confirmed by login (PACKAGE_SPEC.md 14.4). It grants
// reviewing and finishing on the site: it is NOT the on-chain admin (cold key, only the `cli:approve`/`cli:suspend` CLIs).
// Addresses are compared lowercase (D7). Pure (no env): tested in test/publish-rules.test.ts.

/** Admin wallets of a "a,b , c" list (empty entries ignored), lowercase. */
export function parseAdminWallets(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminIn(wallet: string, raw: string): boolean {
  return parseAdminWallets(raw).has(wallet.trim().toLowerCase());
}
