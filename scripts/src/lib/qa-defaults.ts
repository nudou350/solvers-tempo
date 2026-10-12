// Import FIRST in the local-QA scripts (before ../env.js is evaluated): points API_URL at the QA API (127.0.0.1:3028)
// and SERVER_ENV_FILE at apps/server/.env.qa unless they are already set. No other imports on purpose.
import { join } from "node:path";

process.env.API_URL ??= "http://127.0.0.1:3028";
process.env.SERVER_ENV_FILE ??= join(import.meta.dirname, "..", "..", "..", "apps", "server", ".env.qa");
