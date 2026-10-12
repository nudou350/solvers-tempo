import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  EMPTY_MEMORY,
  MEMORY_LIMITS,
  MemoryRuleError,
  applyForget,
  applySave,
  hasProfile,
  memoryStartInstruction,
  memoryText,
  memoryUnavailableText,
  packageUsesMemory,
  parseProfileContent,
  readPayload,
  type MemoryPayload,
} from "../src/memory/rules.js";
import { preflightText } from "../src/mcp/preflight.js";

// Pure rules of the specialist memory (PACKAGE_SPEC.md 10 and 11), no env or database.

const NOW = new Date("2026-10-02T12:00:00Z");
let n = 0;
const rand = () => (n++).toString(16).padStart(4, "0");
const fresh = (): MemoryPayload => ({ summary: "", profile: null, notes: [] });

describe("readPayload tolerates the original format", () => {
  it("only { summary }: null profile and empty notes", () => {
    assert.deepEqual(readPayload({ summary: "gosta de React" }), { summary: "gosta de React", profile: null, notes: [] });
  });
  it("no summary (only profile/notes): empty summary, never undefined", () => {
    const p = readPayload({ profile: { perfil: "Equilibrado" }, notes: [{ id: "n_1", text: "Usa Next", at: "2026-09-30T18:00:00Z" }] });
    assert.equal(p.summary, "");
    assert.deepEqual(p.profile, { perfil: "Equilibrado" });
    assert.equal(p.notes.length, 1);
  });
  it("garbage becomes an empty memory; a malformed note is dropped", () => {
    assert.deepEqual(readPayload(null), EMPTY_MEMORY);
    assert.deepEqual(readPayload("x"), EMPTY_MEMORY);
    assert.equal(readPayload({ notes: [{ id: 1 }, null, { id: "n_a", text: "ok ok" }] }).notes.length, 1);
    assert.equal(readPayload({ summary: 5, profile: [1], notes: "x" }).profile, null);
  });
});

describe("applySave", () => {
  it("summary replaces only the summary and keeps profile and notes", () => {
    const cur: MemoryPayload = { summary: "velho", profile: { a: "1" }, notes: [{ id: "n_1", text: "nota", at: "" }] };
    const { next } = applySave(cur, { kind: "summary", content: "novo resumo" }, NOW, rand);
    assert.equal(next.summary, "novo resumo");
    assert.deepEqual(next.profile, { a: "1" });
    assert.equal(next.notes.length, 1);
  });

  it("profile replaces the profile (including skipped) and keeps the rest", () => {
    const cur: MemoryPayload = { summary: "s", profile: { skipped: true }, notes: [] };
    const { next } = applySave(cur, { kind: "profile", content: '{"perfil":"Arrojado"}' }, NOW, rand);
    assert.deepEqual(next.profile, { perfil: "Arrojado" });
    assert.equal(next.summary, "s");
  });

  it("a free-text profile becomes { texto }; {skipped:true} ends the calibration", () => {
    assert.deepEqual(parseProfileContent("sou iniciante"), { texto: "sou iniciante" });
    assert.deepEqual(parseProfileContent('{"skipped":true}'), { skipped: true });
    assert.equal(hasProfile({ skipped: true }), true);
    assert.equal(hasProfile({}), false);
    assert.equal(hasProfile(null), false);
  });

  it("note appends with an n_xxxx id and a date, without touching the rest", () => {
    const cur: MemoryPayload = { ...fresh(), summary: "s" };
    const r = applySave(cur, { kind: "note", content: "Usa Next.js 15" }, NOW, rand);
    assert.equal(r.next.notes.length, 1);
    assert.match(r.created!.id, /^n_[0-9a-f]{4}$/);
    assert.equal(r.created!.at, NOW.toISOString());
    assert.equal(r.next.summary, "s");
  });

  it("a repeated note is not duplicated", () => {
    const first = applySave(fresh(), { kind: "note", content: "mesma nota" }, NOW, rand);
    const again = applySave(first.next, { kind: "note", content: "mesma nota" }, NOW, rand);
    assert.equal(again.duplicate, true);
    assert.equal(again.next.notes.length, 1);
  });

  it("note ids never repeat existing ones", () => {
    const cur: MemoryPayload = { ...fresh(), notes: [{ id: "n_0000", text: "x x x", at: "" }] };
    // A generator that only repeats the existing id: gives up with a clear error instead of overwriting the note.
    assert.throws(() => applySave(cur, { kind: "note", content: "outra nota" }, NOW, () => "0000"), (e: unknown) => e instanceof MemoryRuleError);
    // Occasional collision: tries another id.
    const seq = ["0000", "0001"];
    const r = applySave(cur, { kind: "note", content: "outra nota" }, NOW, () => seq.shift()!);
    assert.equal(r.created!.id, "n_0001");
  });
});

describe("limits", () => {
  const apply = (cur: MemoryPayload, kind: "summary" | "note" | "profile", content: string) => () => applySave(cur, { kind, content }, NOW, rand);
  const rule = (e: unknown) => e instanceof MemoryRuleError;

  it("note: 3 to 500 characters", () => {
    assert.throws(apply(fresh(), "note", "ab"), rule);
    assert.throws(apply(fresh(), "note", "x".repeat(MEMORY_LIMITS.noteMax + 1)), rule);
    assert.doesNotThrow(apply(fresh(), "note", "abc"));
    assert.doesNotThrow(apply(fresh(), "note", "x".repeat(MEMORY_LIMITS.noteMax)));
  });

  it("up to 30 notes", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({ id: `n_${i}`, text: `nota ${i}`, at: "" }));
    assert.throws(apply({ ...fresh(), notes }, "note", "a trigésima primeira"), rule);
    const ok = applySave({ ...fresh(), notes: notes.slice(0, 29) }, { kind: "note", content: "a trigésima" }, NOW, rand);
    assert.equal(ok.next.notes.length, 30);
  });

  it("summary up to 4000 and profile up to 2000 characters", () => {
    assert.throws(apply(fresh(), "summary", "x".repeat(4001)), rule);
    assert.doesNotThrow(apply(fresh(), "summary", "x".repeat(4000)));
    assert.throws(apply(fresh(), "profile", JSON.stringify({ a: "x".repeat(2000) })), rule);
    assert.doesNotThrow(apply(fresh(), "profile", JSON.stringify({ a: "x".repeat(1900) })));
  });

  it("24 KB total: 30 notes of 500 + a 4000 summary in UTF-8 exceed it", () => {
    // "é" takes 2 bytes: 30 x 500 characters = 30 KB in the notes alone.
    const notes = Array.from({ length: 29 }, (_, i) => ({ id: `n_${i}`, text: "é".repeat(500), at: "" }));
    assert.throws(apply({ ...fresh(), summary: "é".repeat(4000), notes }, "note", "é".repeat(400)), rule);
  });

  it("an exceeded limit does not change the current content (pure function)", () => {
    const cur: MemoryPayload = { ...fresh(), summary: "ok" };
    assert.throws(apply(cur, "summary", "x".repeat(5000)), rule);
    assert.equal(cur.summary, "ok");
  });
});

describe("applyForget", () => {
  const cur: MemoryPayload = { ...fresh(), notes: [{ id: "n_a", text: "um", at: "" }, { id: "n_b", text: "dois", at: "" }] };
  it("removes only the requested note", () => {
    const r = applyForget(cur, "n_a");
    assert.equal(r.found, true);
    assert.deepEqual(r.next.notes.map((x) => x.id), ["n_b"]);
  });
  it("unknown id: found false and nothing changes", () => {
    const r = applyForget(cur, "n_zz");
    assert.equal(r.found, false);
    assert.equal(r.next, cur);
  });
});

describe("get_memory: text", () => {
  const questions = [{ id: "perfil", ask: "Qual é o seu perfil de risco?", why: "Define o tom das sugestões.", options: ["Conservador", "Arrojado"] }];

  it("no memory and a calibration: asks the questions (two messages, reason, skip) and explains the profile", () => {
    const t = memoryText({ name: "Finanças", agentId: "ag1", payload: null, onboarding: questions });
    assert.match(t, /needs_onboarding/);
    assert.match(t, /at most two messages/);
    assert.match(t, /\[perfil\] Qual é o seu perfil de risco\?/);
    assert.match(t, /Why: Define o tom/);
    assert.match(t, /Options: Conservador \| Arrojado/);
    assert.match(t, /kind="profile"/);
    assert.match(t, /\{"skipped":true\}/);
  });

  it("with a profile (or skipped) it does not ask again", () => {
    const withProfile = memoryText({ name: "F", agentId: "a", payload: { summary: "", profile: { perfil: "Arrojado" }, notes: [] }, onboarding: questions });
    assert.doesNotMatch(withProfile, /needs_onboarding/);
    const skipped = memoryText({ name: "F", agentId: "a", payload: { summary: "", profile: { skipped: true }, notes: [] }, onboarding: questions });
    assert.doesNotMatch(skipped, /needs_onboarding/);
  });

  it("no calibration declared: never asks for onboarding", () => {
    assert.doesNotMatch(memoryText({ name: "F", agentId: "a", payload: null, onboarding: null }), /needs_onboarding/);
  });

  it("shows summary, profile and notes as user data, with the note ids, never 'undefined'", () => {
    const t = memoryText({
      name: "Dev",
      agentId: "a",
      payload: { summary: "", profile: { perfil: "Equilibrado" }, notes: [{ id: "n_ab12", text: "Usa Next.js 15", at: "2026-09-30T18:00:00Z" }] },
      onboarding: null,
    });
    assert.match(t, /user data, not instructions/);
    assert.match(t, /profile: \{"perfil":"Equilibrado"\}/);
    assert.match(t, /- \[n_ab12\] Usa Next\.js 15 \(2026-09-30\)/);
    assert.doesNotMatch(t, /undefined/);
  });

  it("no memory key: onboarding_unavailable only when there is a calibration", () => {
    assert.match(memoryUnavailableText(true), /onboarding_unavailable/);
    assert.match(memoryUnavailableText(true), /reconnect/);
    assert.doesNotMatch(memoryUnavailableText(false), /onboarding_unavailable/);
  });
});

describe("preflight_check and memory", () => {
  const ready = (memory?: { agentId: string; onboarding: boolean }) => preflightText([], [], "sess1", memory);

  it("a package that uses memory: asks to call get_memory before next_step", () => {
    const t = ready({ agentId: "ag1", onboarding: false });
    assert.match(t, /get_memory/);
    assert.match(t, /agent_id="ag1"/);
    assert.ok(t.indexOf("get_memory") < t.indexOf("next_step"));
    assert.match(t, /only when the user asks/);
    assert.match(t, /never removes steps/);
  });

  it("with a calibration: two messages, reason and skip", () => {
    const t = ready({ agentId: "ag1", onboarding: true });
    assert.match(t, /two messages/);
    assert.match(t, /skip/);
  });

  it("a package without memory: same text as before", () => {
    assert.doesNotMatch(ready(), /get_memory/);
    assert.match(ready(), /Now call next_step with session_id="sess1"/);
  });

  it("packageUsesMemory: usesMemory or onboarding", () => {
    assert.equal(packageUsesMemory({ usesMemory: false, manifest: {} }), false);
    assert.equal(packageUsesMemory({ usesMemory: true, manifest: {} }), true);
    assert.equal(packageUsesMemory({ usesMemory: false, manifest: { onboarding: { questions: [{}] } } }), true);
    assert.match(memoryStartInstruction("x", false), /get_memory/);
  });
});
