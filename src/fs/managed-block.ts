// Editors for the two config shapes writers need to own a region of:
//   (a) TOML files (Codex) via a marker-delimited managed block.
//   (b) JSON / JSONC files via a tolerant parser + known-key set/delete.

/** Exact marker lines that delimit the haimaker-managed TOML region. */
export const TOML_BEGIN_MARKER = "# >>> haimaker managed (do not edit between markers) >>>";
export const TOML_END_MARKER = "# <<< haimaker managed <<<";

/**
 * Insert or replace the haimaker-managed block within a TOML document.
 *
 * - If both markers are present, replace ONLY that span (preserving everything
 *   before/after).
 * - Otherwise, insert the block BEFORE the first "[section]" line so it lands
 *   in the top-level table region (TOML rules: top-level keys must precede any
 *   table header). If there is no table header, append to the end.
 * - Never duplicates the block.
 *
 * `blockBody` is the inner content (without markers). It is wrapped in the
 * begin/end markers by this function.
 */
export function applyTomlManagedBlock(existing: string, blockBody: string): string {
  assertMarkersIntact(existing);

  const trimmedBody = blockBody.replace(/^\n+/, "").replace(/\n+$/, "");
  const block = `${TOML_BEGIN_MARKER}\n${trimmedBody}\n${TOML_END_MARKER}`;

  const beginIdx = existing.indexOf(TOML_BEGIN_MARKER);
  const endIdx = existing.indexOf(TOML_END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace the existing span in place, preserving surrounding text exactly.
    const before = existing.slice(0, beginIdx);
    const afterStart = endIdx + TOML_END_MARKER.length;
    const after = existing.slice(afterStart);
    return `${before}${block}${after}`;
  }

  if (existing.length === 0) {
    return `${block}\n`;
  }

  // No existing block: insert before the first table header, which TOML
  // requires top-level keys to precede. Detection skips multiline strings so a
  // `[` on its own line inside `"""..."""` is not mistaken for a header.
  const idx = firstTableHeaderIndex(existing);
  if (idx < 0) {
    // No table header: append the block to the end.
    const sep = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${sep}${block}\n`;
  }

  const before = existing.slice(0, idx);
  const after = existing.slice(idx);
  // Insert block then exactly one newline before the header. Removal strips
  // that single newline back out, restoring `existing` byte-for-byte.
  return `${before}${block}\n${after}`;
}

/**
 * Index of the first line that begins a TOML table header (`[...]` / `[[...]]`),
 * skipping lines inside multiline basic (`"""`) or literal (`'''`) strings.
 * Returns -1 if there is no top-level table header.
 */
function firstTableHeaderIndex(toml: string): number {
  let offset = 0;
  let inMultiline: '"""' | "'''" | null = null;
  for (const line of toml.split("\n")) {
    if (inMultiline) {
      if (line.includes(inMultiline)) inMultiline = null;
    } else {
      const trimmed = line.replace(/^[ \t]+/, "");
      if (trimmed.startsWith("[")) return offset;
      // Track entry into a multiline string opened (and not closed) on this line.
      for (const q of ['"""', "'''"] as const) {
        const first = line.indexOf(q);
        if (first !== -1 && line.indexOf(q, first + 3) === -1) {
          inMultiline = q;
          break;
        }
      }
    }
    offset += line.length + 1; // +1 for the "\n" removed by split
  }
  return -1;
}

/**
 * Guard against a half-present managed block. If exactly one marker is found we
 * cannot safely replace or remove the region, so we fail loudly rather than
 * insert a second block or silently corrupt the file.
 */
function assertMarkersIntact(existing: string): void {
  const hasBegin = existing.includes(TOML_BEGIN_MARKER);
  const hasEnd = existing.includes(TOML_END_MARKER);
  if (hasBegin !== hasEnd) {
    throw new Error(
      `The haimaker managed block in this TOML file looks corrupted ` +
        `(found ${hasBegin ? "the begin" : "the end"} marker but not its pair). ` +
        `Restore from the *.haimaker.bak backup or remove the stray marker, then re-run.`
    );
  }
}

/**
 * Remove top-level `key = ...` assignments (those appearing before the first
 * table header) for the given keys. Used by the Codex writer to take ownership
 * of `model` / `model_provider` without producing duplicate top-level keys
 * (which is invalid TOML). String literals are skipped so a `[` inside a value
 * is not treated as a table header.
 */
export function stripTopLevelTomlKeys(toml: string, keys: string[]): string {
  const headerIdx = firstTableHeaderIndex(toml);
  const head = headerIdx < 0 ? toml : toml.slice(0, headerIdx);
  const tail = headerIdx < 0 ? "" : toml.slice(headerIdx);
  const pattern = topLevelKeyPattern(keys);

  const kept = head.split("\n").filter((line) => !pattern.test(line));
  return kept.join("\n") + tail;
}

/**
 * Verbatim top-level `key = ...` lines (those before the first table header) for
 * the given keys. Pairs with stripTopLevelTomlKeys so a writer can capture the
 * values it is about to take over and restore them later.
 */
export function topLevelKeyLines(toml: string, keys: string[]): string[] {
  const headerIdx = firstTableHeaderIndex(toml);
  const head = headerIdx < 0 ? toml : toml.slice(0, headerIdx);
  const pattern = topLevelKeyPattern(keys);
  return head.split("\n").filter((line) => pattern.test(line));
}

/**
 * Prepend top-level `key = ...` lines to a TOML document. Top-level keys must
 * precede any table header, so inserting at the very top is always valid. Used
 * on uninstall to restore values a writer previously took over.
 */
export function prependTopLevelTomlLines(toml: string, lines: string[]): string {
  if (lines.length === 0) return toml;
  return lines.join("\n") + "\n" + toml;
}

/** Comment prefix used to stash taken-over top-level values inside our block. */
export const TOML_RESTORE_PREFIX = "# haimaker:restore ";

function topLevelKeyPattern(keys: string[]): RegExp {
  return new RegExp(`^[ \\t]*(?:${keys.map(escapeRegExp).join("|")})[ \\t]*=`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove the haimaker-managed block from a TOML document (if present),
 * collapsing the surrounding blank lines it introduced. Returns the document
 * unchanged when no block is found.
 */
export function removeTomlManagedBlock(existing: string): string {
  assertMarkersIntact(existing);
  const beginIdx = existing.indexOf(TOML_BEGIN_MARKER);
  const endIdx = existing.indexOf(TOML_END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return existing;

  const before = existing.slice(0, beginIdx);
  const afterStart = endIdx + TOML_END_MARKER.length;
  let after = existing.slice(afterStart);

  // Strip exactly one newline that apply() inserted immediately after the end
  // marker, so the surrounding text is restored byte-for-byte.
  after = after.replace(/^\n/, "");
  return `${before}${after}`;
}

// ---------------------------------------------------------------------------
// JSON / JSONC known-key editor
// ---------------------------------------------------------------------------

/**
 * Tolerant parser: strips // line comments, /* *​/ block comments, and trailing
 * commas before handing off to JSON.parse. This lets us read JSONC/JSON5-ish
 * agent configs.
 *
 * NOTE: this is lossy — comments are discarded, so a parse -> stringify rewrite
 * does NOT preserve user comments. That is an accepted v1 tradeoff: writers own
 * a known set of keys and rewrite the whole file.
 */
export function parseJsonish(text: string): any {
  if (text == null) return {};
  const stripped = removeTrailingCommas(stripComments(text));
  if (stripped.trim().length === 0) return {};
  return JSON.parse(stripped);
}

/**
 * Strip // line and /* *​/ block comments, leaving string literals untouched
 * (so `"http://x"` and `"/* not a comment *​/"` survive verbatim).
 */
function stripComments(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;
  let stringQuote = "";

  while (i < n) {
    const ch = input[i];
    const next = i + 1 < n ? input[i + 1] : "";

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // copy the escaped char verbatim
        if (i + 1 < n) {
          out += input[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      // line comment: skip to end of line
      i += 2;
      while (i < n && input[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      // block comment: skip to closing */
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Remove trailing commas that precede a `}` or `]`, but ONLY outside string
 * literals. A global regex would corrupt values like `"Wait, ]"`, so we track
 * string state and decide per comma. Comments must already be stripped.
 */
function removeTrailingCommas(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;
  let stringQuote = "";

  while (i < n) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === ",") {
      // Look ahead past whitespace; drop the comma if the next token closes a
      // container. Whitespace is the only thing between (comments are gone).
      let j = i + 1;
      while (j < n && /\s/.test(input[j])) j++;
      if (j < n && (input[j] === "}" || input[j] === "]")) {
        i++; // skip the comma
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Set a nested value at the given key path, creating intermediate objects as
 * needed. Mutates and returns `obj`.
 */
export function setDeep(obj: any, pathArray: string[], value: any): any {
  if (pathArray.length === 0) return obj;
  let cur = obj;
  for (let i = 0; i < pathArray.length - 1; i++) {
    const key = pathArray[i];
    if (cur[key] == null || typeof cur[key] !== "object") {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[pathArray[pathArray.length - 1]] = value;
  return obj;
}

/**
 * Delete a nested value at the given key path. Prunes now-empty parent objects
 * created solely to hold the deleted key. Mutates and returns `obj`.
 */
export function deleteDeep(obj: any, pathArray: string[]): any {
  if (pathArray.length === 0) return obj;
  const stack: Array<{ parent: any; key: string }> = [];
  let cur = obj;
  for (let i = 0; i < pathArray.length - 1; i++) {
    const key = pathArray[i];
    if (cur[key] == null || typeof cur[key] !== "object") {
      return obj; // path does not exist
    }
    stack.push({ parent: cur, key });
    cur = cur[key];
  }
  delete cur[pathArray[pathArray.length - 1]];

  // Prune empty ancestors.
  for (let i = stack.length - 1; i >= 0; i--) {
    const { parent, key } = stack[i];
    if (parent[key] && typeof parent[key] === "object" && Object.keys(parent[key]).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return obj;
}

/** Serialize with 2-space indentation and a trailing newline. */
export function stringifyJson(obj: any): string {
  return JSON.stringify(obj, null, 2) + "\n";
}
