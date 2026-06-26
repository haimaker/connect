import { backupOnce } from "./backup";
import { secureWrite, readIfExists } from "./secure-write";
import { parseJsonish, stringifyJson } from "./managed-block";

/**
 * The shared read -> mutate -> write skeleton every JSON-config writer uses for
 * both configure and uninstall. Only the `mutate` callback differs per agent;
 * the backup, tolerant parse, and atomic 0600 write live here once.
 *
 * - backup:          back the file up once before the first write (configure).
 * - createIfMissing: when false (uninstall), do nothing if the file is absent —
 *                    there is nothing of ours to remove. When true/unset, a
 *                    missing file starts from "{}".
 *
 * The file is rewritten with secureWrite (atomic + chmod 0600) because these
 * configs carry the secret API key.
 */
export async function editJsonConfig(
  filePath: string,
  mutate: (config: any) => void,
  opts: { backup?: boolean; createIfMissing?: boolean } = {}
): Promise<void> {
  if (opts.backup) await backupOnce(filePath);

  const existing = await readIfExists(filePath);
  if (existing == null && opts.createIfMissing === false) return;

  const config = parseJsonish(existing ?? "{}");
  mutate(config);
  await secureWrite(filePath, stringifyJson(config));
}
