// Interactive terminal prompts shared by the flag-driven CLI and the wizard.
// Everything is written to stderr so stdout stays clean for piping. The secret
// API key prompt lives in key.ts (hidden input); this module is for the
// non-secret prompts.

import * as readline from "readline";
import { fetchModels } from "./models";
import { KeyMode } from "./agents/types";

/**
 * Ask a single-line question on stderr and resolve with the typed answer.
 * Handles EOF/close (resolves empty) and stream errors (rejects), and settles
 * exactly once so no promise is left dangling on Ctrl-D.
 */
export function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      rl.close();
      fn();
    };
    rl.on("error", (err) => finish(() => reject(err)));
    rl.on("close", () => finish(() => resolve("")));
    rl.question(prompt, (answer) => finish(() => resolve(answer)));
  });
}

/**
 * Fetch the model list, print a numbered menu, and return the chosen id.
 * - If the list can't be fetched, print a note and return `fallback`.
 * - On an empty / out-of-range selection, return the first option (the injected
 *   haimaker/auto).
 */
export async function pickModelInteractive(
  host: string,
  apiKey: string,
  fallback: string
): Promise<string> {
  let models: string[];
  try {
    models = await fetchModels(host, apiKey);
  } catch (err) {
    console.error(`Could not fetch models (${(err as Error).message}); using ${fallback}.`);
    return fallback;
  }
  models.forEach((m, i) => console.error(`  ${i + 1}) ${m}`));
  const sel = (await ask(`Choose a model [default ${models[0]}]: `)).trim();
  // Require a clean integer — "1abc" must fall back to the default, not select 1.
  if (!/^\d+$/.test(sel)) return models[0];
  const n = Number.parseInt(sel, 10);
  return n >= 1 && n <= models.length ? models[n - 1] : models[0];
}

/**
 * Interactive picker for how to provision the API key. Defaults to the safe
 * "env" mode on empty/invalid input, and requires explicit confirmation before
 * the dangerous "inline" mode. Only the env-var/inline-capable agents care.
 */
export async function promptKeyMode(): Promise<KeyMode> {
  console.error(
    "\nHow should connect provide your Haimaker API key to agents that need it?\n" +
      "  1) Reference an environment variable you set yourself.\n" +
      "       Safest — connect won't store the key in your shell or write it for\n" +
      "       env-var agents (you'll set HAIMAKER_API_KEY). [default]\n" +
      "  2) Add `export HAIMAKER_API_KEY=…` to your shell startup file (e.g. ~/.zshrc).\n" +
      "       Convenient — it's set automatically in new shells.\n" +
      "       ⚠️  Your key is stored in PLAINTEXT in a startup file that backups,\n" +
      "          cloud sync, and dotfile repos often capture.\n" +
      "  3) Embed the key directly in the agent's config file.\n" +
      "       Most convenient — no environment variable at all.\n" +
      "       ⚠️⚠️  DANGEROUS: your key sits in PLAINTEXT config files. Never commit\n" +
      "          or share them; anyone who reads the file has your key."
  );
  const sel = (await ask("Choose [1]: ")).trim();
  if (sel === "2") {
    console.error(
      "⚠️  Writing your API key into your shell startup file in plaintext."
    );
    return "profile";
  }
  if (sel === "3") {
    const confirm = (
      await ask(
        "⚠️⚠️  This embeds your key in plaintext config files. Type 'yes' to confirm: "
      )
    )
      .trim()
      .toLowerCase();
    if (confirm === "yes" || confirm === "y") return "inline";
    console.error("Not confirmed — using the safe option (reference an env var).");
    return "env";
  }
  return "env";
}
