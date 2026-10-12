// One messages file per area (messages/<locale>/<namespace>.json), so each area can be edited without conflicts.
// New namespace: create the file in BOTH languages and add the name here.
export const NAMESPACES = [
  "common",
  "format",
  "errors",
  "home",
  "catalog",
  "checkout",
  "install",
  "account",
  "admin",
  "creator",
  "submissions",
  "connect",
  "devkit",
] as const;
