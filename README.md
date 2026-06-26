# @haimaker/connect

**Point your local agents at [Haimaker](https://haimaker.ai) with one command.** No proxy, no config spelunking.

```bash
npx -y @haimaker/connect
```

`connect` edits each supported agent's own config file so it talks straight to
`https://api.haimaker.ai`, then exits. Nothing keeps running afterward: no proxy,
no background daemon. Haimaker serves OpenAI Chat Completions, OpenAI Responses,
and Anthropic Messages directly, so the agent just points at it. One key gets you
200+ frontier and open-source models through a single OpenAI-compatible endpoint.

It's a small, pure-TypeScript CLI that leans on Node's built-ins. Its only
runtime dependencies are a TOML and a YAML parser, lazy-loaded just for the Codex
and Hermes writers. It runs on macOS, Linux, and Windows on Node 18 or newer, and
sends no telemetry.

---

## Quick start

```bash
# Interactive: auto-detect installed agents, pick which to configure, paste a key
npx -y @haimaker/connect

# Or configure one agent non-interactively
HAIMAKER_API_KEY=sk-... npx @haimaker/connect --claude
```

You'll need a Haimaker API key; create one at https://app.haimaker.ai/api-keys.

By default it configures the `haimaker/auto` model (an auto-router that picks a
model per request) and runs one live request to confirm the connection works
before exiting.

---

## Supported agents

| Agent | Flag | Surface | Status |
|---|---|---|---|
| Hermes | `--hermes` | OpenAI Chat | Stable (config-only)¹ |
| OpenClaw | `--openclaw` | OpenAI Chat | Stable |
| opencode | `--opencode` | OpenAI Chat | Stable, supports `--project` |
| Claude Code | `--claude` | Anthropic Messages | Stable |
| Codex | `--codex` | OpenAI Responses | Stable² |
| Cline | `--cline` | OpenAI Chat | Stable (CLI)³ |
| Kilo Code | `--kilo` | OpenAI Chat | Stable |

All seven are verified end-to-end against real installs on macOS (config path,
schema, and a live round-trip through Haimaker).

¹ Hermes is wired up through config alone (no Python plugin). It registers a
`haimaker` custom provider in `~/.hermes/config.yaml` and writes the key to
`~/.hermes/.env`, which Hermes loads on its own.

² Codex talks to `/v1/responses` and reads `HAIMAKER_API_KEY` from its runtime
environment (see below). It works on the default `haimaker/auto` router.

³ Cline support configures the Cline **CLI** — it writes
`~/.cline/data/settings/providers.json` (the same file `cline auth` produces),
pointing Cline's OpenAI-compatible provider at Haimaker. The Cline **VS Code
extension** keeps its provider config in VS Code's internal state and the API key
in the OS keychain, which a file-based tool can't safely set; configure the
extension through its GUI.

Select several at once: `npx @haimaker/connect --claude --opencode`.

---

## Usage

```
npx -y @haimaker/connect [agent flags] [options]
```

Run it with no agent flags to start the interactive wizard: it detects installed
agents, asks which to configure, reads your key with a hidden prompt, then
configures and verifies each one.

### Options

| Option | Description |
|---|---|
| `--project` | Write project-local config in the current repo and add the key-bearing file to `.gitignore`. opencode only. |
| `--model <id>` | Model to configure (default `haimaker/auto`). e.g. `openai/gpt-4o`, `deepseek/deepseek-v3`. |
| `--pick-model` | Pick a model interactively from `GET /v1/models`. |
| `--api-key <key>` | Pass the key inline. Discouraged: it lands in your shell history, so prefer `HAIMAKER_API_KEY` or the hidden prompt. |
| `--key-mode <mode>` | How to provide your key to agents that read it from the environment (Codex). `env` (default), `profile`, or `inline` — see [Key handling](#key-handling). Interactive runs prompt for this. |
| `--no-verify` | Skip the live verification request after writing config. |
| `--uninstall` | Remove the haimaker config we added from the selected (or all detected) agents. |
| `--host <url>` | Override the API host (default `https://api.haimaker.ai`). Must be `https://`. |
| `--allow-insecure-host` | Permit an `http://` host for local testing. The key would be sent in cleartext. |
| `--dir <path>` | Override the base config home, for sandboxing or testing without touching real dotfiles. |
| `-h, --help` | Show help. |
| `-v, --version` | Show version. |

### API key resolution

In order of precedence:

1. `--api-key <key>` (discouraged; visible in shell history)
2. `HAIMAKER_API_KEY` environment variable
3. Hidden interactive prompt (input is never echoed)

The key is never printed in logs, echoed commands, or error messages.

### Key handling

Most agents (Claude Code, opencode, Kilo, OpenClaw, Cline) store the key in
their own `0600` config — they work immediately, no environment variable needed.
**Codex** is the exception: it reads `HAIMAKER_API_KEY` from your shell at
runtime. `--key-mode` controls how that's provided (interactive runs prompt for
it; the default is the safe option):

| Mode | What it does | Safety |
|---|---|---|
| `env` *(default)* | Codex references `HAIMAKER_API_KEY`; **you** set it. connect doesn't touch your shell. | Safest — connect persists no secret for Codex. |
| `profile` | connect also writes `export HAIMAKER_API_KEY=…` into your shell startup file (`~/.zshrc`/`~/.bashrc`), so a new terminal just works. | ⚠️ Your key is stored in plaintext in a startup file that backups, cloud sync, and dotfile repos often capture. |
| `inline` | Embed the literal key directly in the agent's config (for Hermes, `api_key` in `config.yaml` instead of the `.env` reference). | ⚠️⚠️ **Dangerous** — the secret sits in a plaintext config file; never commit or share it. |

`--uninstall` removes the shell-profile export it added, alongside each agent's
config.

### Examples

```bash
# Configure Claude Code with a specific model
HAIMAKER_API_KEY=sk-... npx @haimaker/connect --claude --model deepseek/deepseek-v3

# Configure opencode for the current repo (writes ./opencode.json, gitignores it)
npx @haimaker/connect --opencode --project

# Pick a model interactively from the live model list
npx @haimaker/connect --opencode --pick-model

# Configure Codex (then export HAIMAKER_API_KEY in your shell)
npx @haimaker/connect --codex

# Remove the config we added from Claude Code
npx @haimaker/connect --uninstall --claude
```

---

## How it works

`connect` edits each agent's own config file in place:

- It touches only the keys it owns. For JSON configs that's the `haimaker`
  provider block, plus the default model if you haven't set your own. For Codex's
  TOML it's a marker-delimited managed block. Everything else (other providers,
  your theme, your settings) stays untouched.
- It backs the file up before the first change, to `<file>.haimaker.bak`.
- `--uninstall` removes exactly those keys and nothing else.
- Re-running it produces the same file; nothing duplicates.
- It verifies. After writing, `connect` sends one minimal request on the agent's
  actual protocol surface and reports pass or fail (skip with `--no-verify`). On
  failure your config is left in place, with an error that says what to fix.

### Codex and the API key

Codex reads the `HAIMAKER_API_KEY` environment variable at runtime, so its
`config.toml` holds no secret. With the default `--key-mode env`, `connect`
reminds you to export `HAIMAKER_API_KEY` yourself; with `--key-mode profile` it
writes that export into your shell startup file for you (see
[Key handling](#key-handling)).

### Hermes (config-only)

Hermes is set up entirely through config, no Python plugin. `connect` adds a
`haimaker` entry to `custom_providers` in `~/.hermes/config.yaml` (preserving your
comments and other providers) and writes the key to `~/.hermes/.env` with
`key_env: HAIMAKER_API_KEY`. Hermes loads that `.env` itself, so there's nothing to
export. It also makes haimaker the active model when your provider is unset or
Hermes' default `auto` — but if you've deliberately selected a named provider,
`connect` leaves it alone; switch in-session with `/model custom:haimaker:haimaker/auto`
(or `hermes -m haimaker/auto --provider custom:haimaker`).

---

## Security & privacy

- Your key is never logged, echoed, or printed in an error message.
- Config files that hold the key are written `0600` (owner read/write only), with
  an atomic write that follows symlinks instead of clobbering them, so Stow and
  Chezmoi setups survive. Backups are `0600` too.
- Under `--project`, the key-bearing file is gitignored before it's written, and
  `connect` refuses to write into a file that git already tracks.
- The key only ever goes to an `https://` host. `http://` is refused unless you
  pass `--allow-insecure-host`.
- Network calls time out instead of hanging.
- No telemetry. The only requests it makes are listing models (`--pick-model`)
  and the verify call.

---

## About Haimaker

Haimaker is one API for 200+ frontier and open-source models, with a single key
and a single bill. It's drop-in OpenAI-compatible:

```bash
export OPENAI_BASE_URL=https://api.haimaker.ai/v1
export OPENAI_API_KEY=sk-...
# everything else stays the same
```

New models show up on launch day. 

The same API works for a weekend prototype and a production deployment,
so what you build on now won't turn into a migration project later. More at
[haimaker.ai](https://haimaker.ai).

---

## Requirements

- Node 18 or newer (it uses the built-in global `fetch`).
- macOS, Linux, and native Windows.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest (all writers run against temp-dir fixtures)
```

Every filesystem test runs against an isolated temporary directory, so the suite
never touches your real `~/.claude`, `~/.codex`, and so on.

## Contributing

Issues and PRs welcome. Adding an agent is a module implementing the
`AgentWriter` interface (`src/agents/<id>.ts`) plus its tests, registered in
`src/agents/index.ts`, with its `--flag` wired into `AGENT_FLAGS` and the usage
text in `src/cli.ts`. Verify the config path and schema against a real install
before adding it.

## License

MIT © Haimaker
