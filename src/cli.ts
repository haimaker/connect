#!/usr/bin/env node
// haimaker connect — write each supported coding agent's NATIVE config so it
// talks directly to api.haimaker.ai, then exit. No router, no proxy, no
// telemetry. The secret API key is NEVER printed in logs, commands, or errors.

import * as path from "path";

import { ALL_WRITERS, byId, detectInstalled } from "./agents/index";
import { AgentWriter, InstallCtx, Scope, KeyMode } from "./agents/types";
import { DEFAULT_HOST, DEFAULT_MODEL, KEYS_URL, API_KEY_ENV, validateHost } from "./endpoint";
import { resolveApiKey } from "./key";
import { pickModelInteractive, promptKeyMode } from "./prompt";
import { applyAll } from "./apply";
import { removeProfileExport } from "./fs/shell-profile";
import { runWizard } from "./wizard";

/** Map agent selection flags to writer ids. */
const AGENT_FLAGS: Record<string, string> = {
  "--claude": "claude-code",
  "--opencode": "opencode",
  "--kilo": "kilo-code",
  "--openclaw": "openclaw",
  "--codex": "codex",
  "--hermes": "hermes",
  "--cline": "cline",
};

interface ParsedArgs {
  agentIds: string[];
  project: boolean;
  dir?: string;
  model?: string;
  host?: string;
  allowInsecureHost: boolean;
  keyMode?: KeyMode;
  pickModel: boolean;
  apiKey?: string;
  verify: boolean;
  uninstall: boolean;
  help: boolean;
  version: boolean;
  unknown: string[];
  errors: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    agentIds: [],
    project: false,
    allowInsecureHost: false,
    pickModel: false,
    verify: true,
    uninstall: false,
    help: false,
    version: false,
    unknown: [],
    errors: [],
  };

  // Pull the value for a valued flag at argv[i], rejecting a missing value or
  // one that looks like another flag (e.g. `--dir --claude` swallowing --claude).
  const takeValue = (i: number): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith("-") && v !== "-")) {
      out.errors.push(`Option ${argv[i]} requires a value.`);
      return undefined;
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in AGENT_FLAGS) {
      const id = AGENT_FLAGS[a];
      if (!out.agentIds.includes(id)) out.agentIds.push(id);
      continue;
    }
    switch (a) {
      case "--project":
        out.project = true;
        break;
      case "--dir": {
        const v = takeValue(i);
        if (v !== undefined) { out.dir = v; i++; }
        break;
      }
      case "--model": {
        const v = takeValue(i);
        if (v !== undefined) { out.model = v; i++; }
        break;
      }
      case "--host": {
        const v = takeValue(i);
        if (v !== undefined) { out.host = v; i++; }
        break;
      }
      case "--api-key": {
        const v = takeValue(i);
        if (v !== undefined) { out.apiKey = v; i++; }
        break;
      }
      case "--allow-insecure-host":
        out.allowInsecureHost = true;
        break;
      case "--key-mode": {
        const v = takeValue(i);
        if (v !== undefined) {
          i++;
          if (v === "env" || v === "profile" || v === "inline") out.keyMode = v;
          else out.errors.push(`--key-mode must be one of: env, profile, inline (got ${JSON.stringify(v)}).`);
        }
        break;
      }
      case "--pick-model":
        out.pickModel = true;
        break;
      case "--no-verify":
        out.verify = false;
        break;
      case "--uninstall":
        out.uninstall = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--version":
      case "-v":
        out.version = true;
        break;
      default:
        out.unknown.push(a);
    }
  }
  return out;
}

const USAGE = `haimaker connect — point local coding agents at api.haimaker.ai

Usage:
  npx @haimaker/connect [agent flags] [options]

Run with no agent flags to launch the interactive wizard (auto-detects
installed agents).

Agent flags (select one or more):
  --claude       Claude Code        (~/.claude/settings.json)
  --opencode     opencode           (supports --project)
  --hermes       Hermes             (~/.hermes/config.yaml + .env)
  --codex        Codex              (~/.codex/config.toml; reads HAIMAKER_API_KEY)
  --cline        Cline CLI          (~/.cline/data/settings/providers.json)
  --kilo         Kilo Code          (~/.config/kilo/kilo.jsonc)
  --openclaw     OpenClaw           (~/.openclaw/openclaw.json)

Options:
  --project              Write project-local config under the current repo and
                         add the key-bearing file to .gitignore (opencode only).
  --dir <path>           Override the base config home (testing / sandboxing).
  --model <id>           Model to configure (default: ${DEFAULT_MODEL}).
  --pick-model           Interactively pick a model from GET /v1/models.
  --api-key <key>        API key (DISCOURAGED — visible in shell history; prefer
                         the HAIMAKER_API_KEY env var or the hidden prompt).
  --key-mode <mode>      How to provide your key to agents that read it from the
                         environment (Codex). Interactive runs prompt for this.
                           env      reference an env var you set (default, safest)
                           profile  also write an export to your shell startup
                                    file (~/.zshrc).  WARNING: plaintext key
                           inline   embed the key in the agent's config file.
                                    ⚠️⚠️ DANGEROUS — secret in plaintext config
  --no-verify            Skip the live verification request after writing config.
  --uninstall            Remove haimaker config from the selected (or all
                         detected) agents.
  --host <url>           Override the API host (default: ${DEFAULT_HOST}).
                         Must be https:// unless --allow-insecure-host is set.
  --allow-insecure-host  Permit an http:// --host (local testing only; the API
                         key would be sent in cleartext).
  -h, --help             Show this help.
  -v, --version          Show version.

Notes:
  Codex authenticates by reading the HAIMAKER_API_KEY environment variable at
  runtime. With the default --key-mode env you export it yourself; --key-mode
  profile sets it in your shell startup file for you.
  Create or copy an API key at ${KEYS_URL}.
`;

function readVersion(): string {
  // Resolve package.json relative to the compiled file. npm always ships
  // package.json in the tarball, so this resolves for published installs. We do
  // NOT swallow failures to a fake "0.0.0" — a broken package layout should
  // surface loudly (the caller prints the error and exits non-zero).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(path.join(__dirname, "..", "package.json")) as { version?: string };
  if (!pkg.version) throw new Error("package.json is missing a version field.");
  return pkg.version;
}

/** Build the Scope from parsed flags. --dir doubles as the project repo root. */
function buildScope(args: ParsedArgs): Scope {
  if (args.project) {
    return { kind: "project", cwd: args.dir ?? process.cwd(), dir: args.dir };
  }
  return { kind: "user", dir: args.dir, cwd: process.cwd() };
}

/** Writers that cannot honor --project (user/global config only). */
function projectUnsupported(writers: AgentWriter[]): AgentWriter[] {
  return writers.filter((w) => !w.projectScope);
}

/** --uninstall path: remove our config from selected, or all detected, agents. */
async function runUninstall(args: ParsedArgs, scope: Scope): Promise<number> {
  let targets: AgentWriter[];
  if (args.agentIds.length > 0) {
    targets = args.agentIds.map((id) => byId(id)).filter((w): w is AgentWriter => !!w);
    // Same guard as install: --project must not touch user/global-only writers
    // (they ignore project scope and would mutate the real home config).
    if (args.project) {
      const bad = projectUnsupported(targets);
      if (bad.length > 0) {
        console.error(
          `✗ --project is not supported for: ${bad.map((w) => w.displayName).join(", ")}. ` +
            `These manage a single global/user config; re-run them without --project.`
        );
        return 1;
      }
    }
  } else {
    targets = await detectInstalled(ALL_WRITERS, scope);
    // Under --project, only operate on project-capable writers so we never strip
    // a global config while the flag claims project scope.
    if (args.project) targets = targets.filter((w) => w.projectScope);
  }

  if (targets.length === 0) {
    console.error("No agents to uninstall.");
    return 0;
  }

  let failures = 0;
  for (const w of targets) {
    try {
      await w.uninstall(scope);
      console.error(`✓ Removed haimaker config from ${w.displayName}`);
    } catch (err) {
      failures++;
      console.error(`✗ ${w.displayName}: uninstall failed — ${(err as Error).message}`);
    }
  }

  // Also remove any HAIMAKER_API_KEY export we may have written to the shell
  // startup file (profile/inline mode). Best-effort, idempotent.
  if (targets.some((w) => w.usesShellEnvKey)) {
    await removeProfileExport(scope, API_KEY_ENV).catch(() => {});
  }

  return failures > 0 ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    process.stdout.write(readVersion() + "\n");
    return 0;
  }
  if (args.unknown.length > 0) {
    console.error(`Unknown argument(s): ${args.unknown.join(", ")}`);
    console.error(`Run with --help for usage.`);
    return 1;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) console.error(`✗ ${e}`);
    console.error(`Run with --help for usage.`);
    return 1;
  }

  let host: string;
  try {
    host = validateHost(args.host ?? DEFAULT_HOST, { allowInsecure: args.allowInsecureHost });
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }

  const scope = buildScope(args);

  // --uninstall never needs the API key.
  if (args.uninstall) {
    return runUninstall(args, scope);
  }

  // No agent flags -> interactive wizard. Refuse in non-interactive contexts so
  // automation fails fast instead of hanging on a prompt.
  if (args.agentIds.length === 0) {
    if (!process.stdin.isTTY) {
      console.error(
        "No agent flags given and stdin is not a TTY. Pass agent flags " +
          "(e.g. --claude) for non-interactive use, or run with --help."
      );
      return 1;
    }
    return runWizard({
      scope,
      host,
      model: args.model ?? DEFAULT_MODEL,
      verify: args.verify,
      apiKeyFlag: args.apiKey,
      pickModel: args.pickModel,
      keyMode: args.keyMode,
    });
  }

  // Every agent flag maps to a real writer id, so this is non-empty here.
  const selected = args.agentIds
    .map((id) => byId(id))
    .filter((w): w is AgentWriter => !!w);

  // --project is only safe for writers that actually implement project scope;
  // the rest would silently write the user/global config. Reject before any write.
  if (args.project) {
    const unsupported = projectUnsupported(selected);
    if (unsupported.length > 0) {
      console.error(
        `✗ --project is not supported for: ${unsupported.map((w) => w.displayName).join(", ")}. ` +
          `These write a single global/user config; re-run them without --project.`
      );
      return 1;
    }
  }

  if (args.apiKey) {
    console.error(
      "! --api-key is visible in your shell history; prefer HAIMAKER_API_KEY or the prompt."
    );
  }

  // Resolve the API key (also required to list models for --pick-model).
  let apiKey: string;
  try {
    apiKey = await resolveApiKey({
      flag: args.apiKey,
      allowPrompt: Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }

  // Determine the model.
  let model = args.model ?? DEFAULT_MODEL;
  if (args.pickModel) {
    model = await pickModelInteractive(host, apiKey, model);
  }

  // Determine how to provision the key. Honor an explicit --key-mode; otherwise,
  // when interactive and a selected agent's behavior depends on it, prompt.
  let keyMode: KeyMode = args.keyMode ?? "env";
  if (args.keyMode === undefined && process.stdin.isTTY && selected.some((w) => w.keyModeAware)) {
    keyMode = await promptKeyMode();
  }

  // Configure + verify each selected agent.
  const ctx: InstallCtx = { scope, host, apiKey, model, verify: args.verify, keyMode };
  const { configFailures, verifyFailures } = await applyAll(selected, ctx);

  if (configFailures > 0) return 1;
  if (verifyFailures > 0) return 2;
  return 0;
}

/* istanbul ignore next */
if (require.main === module) {
  // Catch any stray async rejection so the process exits cleanly with a message
  // instead of dumping an unhandled-rejection stack trace. Never leak the key.
  process.on("unhandledRejection", (reason) => {
    console.error(`✗ ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(1);
  });

  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Defensive: never leak the key; print only the message.
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    });
}
