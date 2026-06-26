// Interactive wizard, run when `connect` is invoked with no agent flags.
//
// Flow: auto-detect installed agents -> let the user choose which to configure
// -> resolve the API key (hidden prompt) -> configure + verify each -> print a
// friendly summary. Prompts are plain readline questions — no blocking modals.

import { ALL_WRITERS, detectInstalled } from "./agents/index";
import { AgentWriter, InstallCtx, Scope, KeyMode } from "./agents/types";
import { resolveApiKey } from "./key";
import { ask, pickModelInteractive, promptKeyMode } from "./prompt";
import { applyAll } from "./apply";

export interface WizardOpts {
  scope: Scope;
  host: string;
  model: string;
  verify: boolean;
  apiKeyFlag?: string;
  pickModel?: boolean;
  /** Explicit --key-mode from the CLI; when undefined the wizard prompts if relevant. */
  keyMode?: KeyMode;
}

/**
 * Writers offered in the wizard. Under project scope, restricted to writers that
 * actually support project-local config (so we never silently write a global
 * config from the interactive flow).
 */
function eligibleWriters(scope: Scope): AgentWriter[] {
  return ALL_WRITERS.filter((w) => scope.kind !== "project" || w.projectScope);
}

/**
 * Parse a selection string like "1,3" or "all" against an ordered list.
 * Empty / "all" selects everything. Non-numeric tokens (e.g. "1abc") are
 * reported and ignored rather than silently treated as "1".
 */
function parseSelection(input: string, options: AgentWriter[]): AgentWriter[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") return [...options];
  const picked: AgentWriter[] = [];
  for (const tok of trimmed.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d+$/.test(tok)) {
      console.error(`  (ignoring invalid selection "${tok}")`);
      continue;
    }
    const n = Number.parseInt(tok, 10);
    if (n >= 1 && n <= options.length) {
      const w = options[n - 1];
      if (!picked.includes(w)) picked.push(w);
    }
  }
  return picked;
}

export async function runWizard(opts: WizardOpts): Promise<number> {
  const eligible = eligibleWriters(opts.scope);
  if (eligible.length === 0) {
    console.error("No agents available to configure for this scope.");
    return 0;
  }

  // 1. Auto-detect (concurrent, best-effort).
  const detected = await detectInstalled(eligible, opts.scope);
  const options = detected.length > 0 ? detected : eligible;

  console.error("haimaker connect — point your local coding agents at api.haimaker.ai\n");
  if (detected.length > 0) {
    console.error("Detected the following agents:");
  } else {
    console.error("No agents auto-detected. Choose which to configure:");
  }
  options.forEach((w, i) => {
    console.error(`  ${i + 1}) ${w.displayName}`);
  });

  const sel = await ask("\nWhich agents to configure? [comma-separated numbers, or 'all']: ");
  const chosen = parseSelection(sel, options);
  if (chosen.length === 0) {
    console.error("Nothing selected. Exiting.");
    return 0;
  }

  // 2. Resolve the API key (hidden prompt allowed here).
  let apiKey: string;
  try {
    apiKey = await resolveApiKey({ flag: opts.apiKeyFlag, allowPrompt: true });
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }

  // 3. Optional model picker.
  let model = opts.model;
  if (opts.pickModel) {
    model = await pickModelInteractive(opts.host, apiKey, model);
  }

  // 3b. Key-handling mode. Honor an explicit --key-mode; otherwise prompt only
  // when a chosen agent's behavior depends on it (Codex / Hermes).
  let keyMode: KeyMode = opts.keyMode ?? "env";
  if (opts.keyMode === undefined && chosen.some((w) => w.keyModeAware)) {
    keyMode = await promptKeyMode();
  }

  // 4. Configure + verify each chosen agent.
  const ctx: InstallCtx = {
    scope: opts.scope,
    host: opts.host,
    apiKey,
    model,
    verify: opts.verify,
    keyMode,
  };
  const { configFailures, verifyFailures } = await applyAll(chosen, ctx);

  // 5. Summary.
  console.error("");
  if (configFailures === 0 && verifyFailures === 0) {
    console.error(`Done. Configured ${chosen.length} agent(s) for model "${model}".`);
    return 0;
  }
  console.error(
    `Finished with issues: ${configFailures} configure failure(s), ${verifyFailures} verify failure(s).`
  );
  return configFailures > 0 ? 1 : 2;
}
