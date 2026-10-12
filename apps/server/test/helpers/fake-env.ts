// Import THIS file first in tests that load modules reading env.ts at import time (no .env, as in CI).
// Placeholder values are enough: nothing here connects to the database or the chain. The keys are public anvil dev keys.
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://x:x@127.0.0.1:1/x",
  CHAIN_ID: process.env.CHAIN_ID ?? "31337",
  PLATFORM_PRIVATE_KEY: process.env.PLATFORM_PRIVATE_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  RELAY_PRIVATE_KEY: process.env.RELAY_PRIVATE_KEY ?? "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  VERIFIER_PRIVATE_KEY: process.env.VERIFIER_PRIVATE_KEY ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  TREASURY_ADDRESS: process.env.TREASURY_ADDRESS ?? "0x000000000000000000000000000000000000dead",
  JWT_SECRET: process.env.JWT_SECRET ?? "j".repeat(40),
  SERVER_KEK: process.env.SERVER_KEK ?? Buffer.alloc(32, 7).toString("base64"),
});
