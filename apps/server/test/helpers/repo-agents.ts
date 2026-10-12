import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Packages in agents/ that only exist in the working repository: the public export ships only _exemplos and criador-de-solvers.
export const REPO_AGENTS = resolve(import.meta.dirname, "../../../../agents");
export const PAID_SLUGS = ["backend-node", "copy-marketing", "financas-pessoais", "frontend-react", "planejador-viagens", "planilhas-dados", "revisao-contratos", "ui-design"];

/** node:test `skip` option for tests that read the paid packages (false when all of them are present). */
export const SKIP_WITHOUT_PAID = PAID_SLUGS.every((s) => existsSync(join(REPO_AGENTS, s, "manifest.json")))
  ? false
  : "paid packages in agents/ missing (public export)";
