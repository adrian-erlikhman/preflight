// spec.js — sections of the Worldwide Agentic Web MVP spec, from the copy bundled in
// spec/ (Apache 2.0, Cognizant AI Lab), so the assistant can quote the exact text.

export const SPEC_SECTIONS = ["1", "1.1", "1.2", "2", "2.1", "2.2", "3", "3.1", "3.2", "3.3", "3.4", "4", "5", "6", "7", "8"];

/**
 * Split the spec's Markdown into numbered sections.
 *
 * :param markdown: The spec text.
 * :return: A Map of section number to {title, text}. A top-level section's text runs
 *   until the next top-level section, so it includes its subsections.
 */
export function splitSpec(markdown) {
  const lines = markdown.split("\n");
  const heads = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(#{2,3})\s+(\d+(?:\.\d+)?)\.?\s+(.*)$/);
    if (match) heads.push({ index, level: match[1].length, number: match[2], title: match[3].trim() });
  });
  const sections = new Map();
  heads.forEach((head, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= head.level) { end = heads[j].index; break; }
    }
    const text = lines.slice(head.index, end).join("\n").replace(/<!--.*?-->/g, "").trim();
    sections.set(head.number, { title: head.title, text });
  });
  return sections;
}

let cached = null;

/**
 * Read one section of the bundled spec.
 *
 * :param number: A section number such as "3.2".
 * :param fetchImpl: fetch, or a stub in tests.
 * :param base: Where the spec folder is.
 * :return: {ok, section, title, text} or {ok: false, reason}.
 */
export async function specSection(number, fetchImpl, base) {
  if (!cached) {
    const response = await fetchImpl(new URL("spec/worldwide_agentic_web_mvp_spec.md", base).href);
    if (!response.ok) return { ok: false, reason: "The bundled copy of the spec could not be read." };
    cached = splitSpec(await response.text());
  }
  const section = cached.get(String(number));
  if (!section) return { ok: false, reason: `There is no section ${number}. Sections: ${SPEC_SECTIONS.join(", ")}.` };
  const limit = 9000;
  return {
    ok: true,
    section: String(number),
    title: section.title,
    text: section.text.length > limit ? `${section.text.slice(0, limit)}\n[…section continues]` : section.text,
    source: "Worldwide Agentic Web MVP spec, profile 0.2 (6 November 2026), Cognizant AI Lab, Apache 2.0",
  };
}
