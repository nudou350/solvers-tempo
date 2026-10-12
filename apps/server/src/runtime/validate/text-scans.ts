// Text scans of the creator's content (PACKAGE_SPEC.md 5.1 and 14.5). They are WARNINGS for the reviewer:
// simple, bypassable heuristics; the human reviewer decides. Pure, no env/DB.

/** Invisible, bidirectional and Unicode "tag" characters (used to hide instructions). */
const HIDDEN = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

export function hiddenCharsAt(text: string): { index: number; codePoint: string } | null {
  const m = HIDDEN.exec(text);
  if (!m) return null;
  return { index: m.index, codePoint: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` };
}

// The same character class as `HIDDEN`, in a global version, to scan ALL occurrences (reviewer).
const HIDDEN_G = new RegExp(HIDDEN.source, "gu");

/** All occurrences (up to `max`) of invisible or bidirectional characters: position, code point and number. */
export function hiddenCharsAll(text: string, max = 500): { index: number; codePoint: string; cp: number }[] {
  const out: { index: number; codePoint: string; cp: number }[] = [];
  HIDDEN_G.lastIndex = 0;
  for (let m = HIDDEN_G.exec(text); m && out.length < max; m = HIDDEN_G.exec(text)) {
    const cp = m[0].codePointAt(0)!;
    out.push({ index: m.index, codePoint: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`, cp });
  }
  return out;
}

/** Replaces invisible characters with visible `[U+XXXX]` (to show excerpts to the reviewer without hiding anything). */
export function revealHiddenChars(text: string): string {
  return text.replace(HIDDEN_G, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}

/** Typical prompt-injection phrases (PT and EN). */
const INJECTION: RegExp[] = [
  /ignor[ea]\s+(?:todas?\s+)?(?:as\s+)?(?:instru(?:ç|c)(?:õ|o)es|regras)\s+(?:anteriores|acima|do\s+sistema)/i,
  /desconsidere\s+(?:todas?\s+)?(?:as\s+)?(?:instru(?:ç|c)(?:õ|o)es|regras)/i,
  /esque(?:ç|c)a\s+(?:todas?\s+)?(?:as\s+)?(?:instru(?:ç|c)(?:õ|o)es|regras)/i,
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+(?:instructions|rules)/i,
  /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)/i,
  /(?:n(?:ã|a)o|nunca)\s+(?:conte|diga|revele|mostre|avise)\s+(?:isso\s+)?(?:ao|para\s+o)\s+usu(?:á|a)rio/i,
  /do\s+not\s+(?:tell|reveal|show)\s+(?:this\s+)?(?:to\s+)?the\s+user/i,
  /(?:envie|copie|encaminhe|exfiltre)\s+(?:todo\s+)?(?:o\s+)?(?:conte(?:ú|u)do|hist(?:ó|o)rico|dados|mem(?:ó|o)ria|arquivos?)\s+(?:do\s+usu(?:á|a)rio\s+)?para\s+(?:https?:\/\/|um\s+(?:site|servidor|endere(?:ç|c)o))/i,
  /(?:act|aja)\s+(?:as|como)\s+(?:the\s+)?(?:system|sistema|administrador)/i,
  /<\s{0,20}\/?\s{0,20}(?:system|instructions?)\s{0,20}>/i,
];

export function injectionMatch(text: string): string | null {
  for (const re of INJECTION) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** Size cap for a segment a regex runs on: longer lines and URLs are cut (defense against backtracking). */
const MAX_SEGMENT = 2000;

/** Lines of the text, with those longer than `MAX_SEGMENT` split into chunks (no regex runs on a giant segment). */
function* segments(text: string): Generator<string> {
  for (const line of text.split("\n")) {
    if (line.length <= MAX_SEGMENT) yield line;
    else for (let i = 0; i < line.length; i += MAX_SEGMENT) yield line.slice(i, i + MAX_SEGMENT);
  }
}

const ASK_VERBS = /\b(?:pe(?:ç|c)a|solicite|pergunte|informe|envie|forne(?:ç|c)a|cole|digite|ask|request|provide|send)\b/i;
const SENSITIVE = /\b(?:senha|password|cpf|cnpj|n(?:ú|u)mero\s+do\s+cart(?:ã|a)o|cart(?:ã|a)o\s+de\s+cr(?:é|e)dito|cvv|c(?:ó|o)digo\s+de\s+seguran(?:ç|c)a|token\s+de\s+acesso|chave\s+privada|frase\s+secreta|seed\s+phrase|login\s+do\s+gov\.?br)\b/i;
const NEGATION = /\b(?:nunca|jamais|n(?:ã|a)o|sem|evite|never|don'?t|do\s+not)\b/i;

/** A line that tells the assistant to ask the user for sensitive data (ignores lines saying "never ask ..."). */
export function sensitiveAsk(text: string): string | null {
  for (const line of segments(text)) {
    if (ASK_VERBS.test(line) && SENSITIVE.test(line) && !NEGATION.test(line)) return line.trim().slice(0, 160);
  }
  return null;
}

const URL_RE = /https?:\/\/[^\s)>\]"'`]{1,2000}/gi;
const SEND_WORDS = /\b(?:envie|enviar|poste|post|upload|webhook|encaminhe|submeta|submit|send|grave\s+em)\b/i;

/** Has `?` followed (before any `#`) by `=`: query parameters. Linear (the regex `\?[^#\s]*=` was quadratic). */
function hasQueryParams(u: string): boolean {
  const q = u.indexOf("?");
  if (q === -1) return false;
  const eq = u.indexOf("=", q + 1);
  if (eq === -1) return false;
  const hash = u.indexOf("#", q + 1);
  return hash === -1 || eq < hash;
}

/** Strips trailing punctuation from the URL (linear). */
function trimTrailingPunct(u: string): string {
  let end = u.length;
  while (end > 0 && ".,;:!?".includes(u[end - 1]!)) end -= 1;
  return u.slice(0, end);
}

/** Data-sending URL: on the same line as a sending verb, or with query parameters (?a=b). */
export function sendingUrl(text: string): string | null {
  for (const line of segments(text)) {
    const urls = line.match(URL_RE);
    if (!urls) continue;
    for (const u of urls) {
      if (SEND_WORDS.test(line) || hasQueryParams(u)) return u;
    }
  }
  return null;
}

/** All http(s) URLs in the text, without trailing punctuation, flagging the data-sending ones (same criterion as `sendingUrl`). */
export function urlsIn(text: string): { url: string; sending: boolean; line: string }[] {
  const out: { url: string; sending: boolean; line: string }[] = [];
  for (const line of segments(text)) {
    const urls = line.match(URL_RE);
    if (!urls) continue;
    for (const raw of urls) {
      const url = trimTrailingPunct(raw);
      out.push({ url, sending: SEND_WORDS.test(line) || hasQueryParams(url), line: line.trim() });
    }
  }
  return out;
}

const SENSITIVE_QUESTION = /\b(?:senha|password|cpf|cnpj|cart(?:ã|a)o|cvv|token|chave\s+privada|seed|frase\s+secreta|gov\.?br)\b/i;

export function sensitiveQuestion(text: string): boolean {
  return SENSITIVE_QUESTION.test(text);
}
