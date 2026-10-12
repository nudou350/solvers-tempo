// Splitting knowledge into chunks (INSTRUCTIONS.md 5.5): ~500 tokens (~2000 characters) with
// ~50 tokens (~200 characters) of overlap. Pure (no env/DB): the validator estimates the number
// of chunks with this same function, and ingestion stores the result.

export const CHUNK_CHARS = 2000;
export const OVERLAP_CHARS = 200;

/** Splits ONE section: whole if it fits in CHUNK_CHARS; otherwise by paragraph, with overlap and the heading repeated. */
function splitSection(section: string): string[] {
  if (section.length <= CHUNK_CHARS) return [section];
  const out: string[] = [];
  const heading = /^#{1,3} .+$/m.exec(section)?.[0] ?? "";
  const paras = section.split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > CHUNK_CHARS) {
      out.push(cur.trim());
      const tail = cur.slice(-OVERLAP_CHARS);
      cur = `${heading && !tail.startsWith(heading) ? `${heading}\n\n` : ""}…${tail}\n\n${p}`;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Splits first by sections (##), then by paragraphs, keeping the section heading in each chunk. */
export function chunkMarkdown(md: string): string[] {
  const sections = md.split(/\n(?=#{1,3} )/g).map((s) => s.trim()).filter(Boolean);
  return sections.flatMap(splitSection);
}

/** `.txt`: the file is a single section (lines starting with "#" do not become headings); only size splits it. */
export function chunkPlainText(text: string): string[] {
  const t = text.trim();
  return t ? splitSection(t) : [];
}
