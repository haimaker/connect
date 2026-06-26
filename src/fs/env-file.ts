// Minimal upsert/remove for a `.env`-style file (KEY=value lines). We edit lines
// directly instead of parsing, so unrelated lines, blanks, and comments are
// preserved. Used for the secret half of agents that read a `.env` (Hermes).

const SAFE_VALUE = /^[A-Za-z0-9_./:+~@-]+$/;

function formatValue(value: string): string {
  // Quote only when a value contains characters a naive dotenv reader could
  // misparse (spaces, '#', quotes, etc.). API keys normally need no quoting.
  return SAFE_VALUE.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function keyLinePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`);
}

/** Set `name=value`, replacing the first existing assignment or appending one. */
export function upsertEnvVar(content: string, name: string, value: string): string {
  const line = `${name}=${formatValue(value)}`;
  const pattern = keyLinePattern(name);

  const existing = content ?? "";
  const lines = existing.split("\n");
  let replaced = false;
  const out = lines.map((l) => {
    if (!replaced && pattern.test(l)) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (replaced) return out.join("\n");

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  return `${existing}${needsNewline ? "\n" : ""}${line}\n`;
}

/** Remove every assignment of `name`, preserving all other lines. */
export function removeEnvVar(content: string, name: string): string {
  const existing = content ?? "";
  if (existing.length === 0) return existing;
  const pattern = keyLinePattern(name);
  return existing
    .split("\n")
    .filter((l) => !pattern.test(l))
    .join("\n");
}
