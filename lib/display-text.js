// Turns Ivaan's raw reply text into display lines so that markdown symbols
// (>, *, **, _, #, list markers) are never shown to the user — including
// while a reply is still streaming in and a marker hasn't been closed yet.
//
// Returns an array of lines: { type: "text" | "beat" | "blank", segments }
// where segments are { style: "plain" | "em" | "strong", text }.

// No lookbehind anywhere in this file: older Safari (before 16.4) can't parse it,
// and a parse error here would break the whole page on those devices.
const INLINE = /\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|\b_(?!\s)(.+?)_\b/g;

function stripStray(text) {
  // Any marker left after pairing is unclosed (mid-stream) or stray.
  // Underscores inside words (snake_case) are left alone.
  return text
    .replace(/\*+/g, "")
    .replace(/__/g, "")
    .replace(/(^|\s)_+(?=\S)/g, "$1")
    .replace(/(\S)_+(?=\s|$)/g, "$1");
}

function parseInline(text) {
  const segments = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) segments.push({ style: "plain", text: stripStray(text.slice(last, m.index)) });
    const strong = m[1] ?? m[2];
    const em = m[3] ?? m[4];
    if (strong !== undefined) segments.push({ style: "strong", text: stripStray(strong) });
    else segments.push({ style: "em", text: stripStray(em) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ style: "plain", text: stripStray(text.slice(last)) });
  return segments.filter((s) => s.text.length > 0);
}

// The negated assertion: text only, no emphasis markers (the beat is already italic).
function beat(text) {
  return { type: "beat", segments: [{ style: "plain", text: stripStray(text).trim() }] };
}

function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed === ">") return [{ type: "blank", segments: [] }];

  // Blockquote — the via negativa beat. "> *Sentence.*" and its near-misses.
  if (trimmed.startsWith(">")) {
    const body = trimmed.replace(/^(>\s*)+/, "");
    // A closed emphasis run followed by more words on the same line:
    // the run becomes the beat, the rest continues as ordinary text.
    const split = body.match(/^(\*\*|\*|__|_)(.+?)\1\s+(\S.*)$/);
    if (split) return [beat(split[2]), { type: "text", segments: parseInline(split[3]) }];
    return [beat(body)];
  }

  // Headings: drop the hashes, show the words.
  if (/^#{1,6}\s/.test(trimmed)) {
    return [{ type: "text", segments: parseInline(trimmed.replace(/^#{1,6}\s+/, "")) }];
  }

  // Bulleted list items: swap the marker for a bullet.
  const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
  if (bullet) return [{ type: "text", segments: [{ style: "plain", text: "• " }, ...parseInline(bullet[1])] }];

  // A line that is entirely italic stands alone as the beat too
  // (the negation written without its ">").
  const italicLine = trimmed.match(/^(\*|_)(?![*_\s])(.*\S)\1$/);
  if (italicLine) return [beat(italicLine[2])];

  return [{ type: "text", segments: parseInline(line) }];
}

export function toDisplayLines(text) {
  return text.split("\n").flatMap(parseLine);
}
