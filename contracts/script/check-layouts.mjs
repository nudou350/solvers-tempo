#!/usr/bin/env node
// Storage-layout guard for the UUPS contracts (plan §4.8, AGENTS.md).
// Each ERC-7201 namespace struct is exposed by a probe in script/StorageLayoutProbe.sol. This script flattens the
// layout of every probe (struct members recursively, with relative slot, offset and type) and compares it with the
// committed file under storage-layouts/. Allowed: appending members at the end of a struct (also nested structs),
// renaming a member to `__deprecated_<name>`. Anything else (removal, reorder, retype, offset change, a fixed-size
// array changing byte size, e.g. a grown SolversEscrow.Milestone) fails.
//   node script/check-layouts.mjs           check (exit 1 on an incompatible change or a missing file)
//   node script/check-layouts.mjs --write   regenerate the committed layouts after a reviewed, append-only change
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const PROBES = ["Registry", "License", "Credits", "Reviews", "Escrow", "Staking", "Satellite", "Payouts"];
const write = process.argv.includes("--write");
mkdirSync("storage-layouts", { recursive: true });

function inspect(probe) {
  const out = execFileSync("forge", ["inspect", `script/StorageLayoutProbe.sol:${probe}LayoutProbe`, "storageLayout", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return JSON.parse(out);
}

// Flatten: one row per leaf member, path-qualified, with absolute slot within the namespace.
function flatten(layout) {
  const rows = [];
  const types = layout.types;
  const label = (t) => types[t]?.label ?? t;
  function walk(members, base, prefix) {
    for (const m of members) {
      const slot = BigInt(base) + BigInt(m.slot);
      const path = prefix ? `${prefix}.${m.label}` : m.label;
      const t = types[m.type];
      const row = { path, slot: slot.toString(), offset: m.offset, type: label(m.type) };
      // fixed-size arrays: their byte size must never change (a grown element struct shifts every later element)
      if (t && t.encoding === "inplace" && t.base) row.bytes = t.numberOfBytes;
      rows.push(row);
      describe(m.type, slot, path);
    }
  }
  // Follows a member's type: in-place structs at their slot; fixed arrays, dynamic arrays and mapping values are
  // described once relative to their element (slot 0 of the element), recursively through nested mappings.
  function describe(typeId, slot, path) {
    const t = types[typeId];
    if (!t) return;
    if (t.members && t.encoding === "inplace") walk(t.members, slot, path);
    else if (t.encoding === "inplace" && t.base) describe(t.base, slot, `${path}[i]`);
    else if (t.encoding === "dynamic_array" && t.base) describe(t.base, 0n, `${path}[*]`);
    else if (t.encoding === "mapping" && t.value) describe(t.value, 0n, `${path}[k]`);
  }
  walk(layout.storage, 0n, "");
  return rows;
}

let bad = 0;
for (const p of PROBES) {
  const rows = flatten(inspect(p));
  const file = `storage-layouts/${p}.json`;
  if (write || !existsSync(file)) {
    if (!write) {
      console.error(`missing ${file}; run with --write after review`);
      bad++;
      continue;
    }
    writeFileSync(file, JSON.stringify(rows, null, 2) + "\n");
    console.log(`wrote ${file} (${rows.length} members)`);
    continue;
  }
  const old = JSON.parse(readFileSync(file, "utf8"));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  for (const o of old) {
    const n = byPath.get(o.path) ?? rows.find((r) => r.slot === o.slot && r.offset === o.offset && r.path.endsWith(`__deprecated_${o.path.split(".").pop()}`));
    if (!n) {
      console.error(`${p}: member ${o.path} was removed or renamed (rename only to __deprecated_<name>)`);
      bad++;
    } else if (n.slot !== o.slot || n.offset !== o.offset || n.type !== o.type || n.bytes !== o.bytes) {
      console.error(`${p}: member ${o.path} changed: slot ${o.slot}->${n.slot}, offset ${o.offset}->${n.offset}, type ${o.type}->${n.type}`);
      bad++;
    }
  }
  if (!bad) console.log(`ok ${p} (${old.length} committed members, ${rows.length - old.length} appended)`);
}
// Enums are stored as their ordinal: members may only be appended (a reorder or insert remaps stored values).
const enumsFile = "storage-layouts/enums.json";
const enums = {};
for (const m of readFileSync("src/SolversTypes.sol", "utf8").matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
  enums[m[1]] = m[2].split(",").map((s) => s.trim()).filter(Boolean);
}
if (write || !existsSync(enumsFile)) {
  if (write) {
    writeFileSync(enumsFile, JSON.stringify(enums, null, 2) + "\n");
    console.log(`wrote ${enumsFile}`);
  } else {
    console.error(`missing ${enumsFile}; run with --write after review`);
    bad++;
  }
} else {
  const old = JSON.parse(readFileSync(enumsFile, "utf8"));
  for (const [name, members] of Object.entries(old)) {
    const now = enums[name];
    if (!now || members.some((m, i) => now[i] !== m)) {
      console.error(`enum ${name} changed: [${members}] -> [${now ?? "removed"}] (append-only)`);
      bad++;
    }
  }
  if (!bad) console.log(`ok enums (${Object.keys(old).length})`);
}
process.exit(bad ? 1 : 0);
