import * as readline from "readline";
import { KEYS_URL } from "./endpoint";
import {
  deviceLogin,
  DeviceDeniedError,
  DeviceExpiredError,
  DeviceLoginDeps,
  DeviceLoginUnavailableError,
  DeviceTokenSuccess,
} from "./device";

export interface ResolvedApiKey {
  apiKey: string;
  login?: DeviceTokenSuccess;
}

/**
 * Resolve the haimaker API key.
 *
 * Resolution order:
 *   1. opts.flag (e.g. from --api-key)
 *   2. process.env.HAIMAKER_API_KEY (unless device login is forced)
 *   3. device login (default on a TTY, or forced)
 *   4. hidden interactive prompt (only when opts.allowPrompt is true)
 *
 * The key value is NEVER logged. Before prompting we print the "create a key"
 * hint (KEYS_URL) to stderr.
 */
export async function resolveApiKey(opts: {
  flag?: string;
  allowPrompt: boolean;
  device?: {
    host: string;
    mode: "default" | "force" | "off";
    deps?: DeviceLoginDeps;
  };
}): Promise<ResolvedApiKey> {
  const fromFlag = opts.flag && opts.flag.trim();
  if (fromFlag) return { apiKey: fromFlag };

  if (opts.device?.mode !== "force") {
    const fromEnv = process.env.HAIMAKER_API_KEY && process.env.HAIMAKER_API_KEY.trim();
    if (fromEnv) return { apiKey: fromEnv };
  }

  const shouldUseDevice =
    opts.device &&
    opts.device.mode !== "off" &&
    (opts.device.mode === "force" || process.stdin.isTTY);
  if (shouldUseDevice) {
    try {
      const login = await deviceLogin(opts.device!.host, opts.device!.deps);
      return { apiKey: login.apiKey, login };
    } catch (err) {
      if (err instanceof DeviceDeniedError || err instanceof DeviceExpiredError) throw err;
      if (!(err instanceof DeviceLoginUnavailableError)) throw err;
      console.error("Device login is unavailable; paste an API key instead.");
    }
  }

  if (!opts.allowPrompt) {
    throw new Error(
      "No API key provided. Run again on a machine with a browser (device login), " +
        "pass --api-key, or set HAIMAKER_API_KEY."
    );
  }

  process.stderr.write(`Create or copy an API key at ${KEYS_URL}\n`);
  const key = await promptHidden("Paste your haimaker API key: ");
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("No API key entered.");
  }
  return { apiKey: trimmed };
}

// Control characters the hidden prompt reacts to (built without embedding raw
// control bytes in the source).
const CTRL_C = String.fromCharCode(3); // ETX — interrupt
const CTRL_D = String.fromCharCode(4); // EOT — end of input
const DEL = String.fromCharCode(127); // backspace on most terminals

/**
 * Read a single line from stdin without echoing characters back to the
 * terminal (so a pasted key is not visible).
 *
 * Implemented with TTY raw mode rather than monkey-patching a private readline
 * method, and with explicit handling for Enter, Ctrl-C, Ctrl-D, and backspace.
 * When stdin is not an interactive TTY (piped/CI), we can't mask, so we read one
 * plain line via readline instead.
 */
function promptHidden(prompt: string): Promise<string> {
  const input = process.stdin as NodeJS.ReadStream;
  const output = process.stderr;

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output });
      output.write(prompt);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        rl.close();
        fn();
      };
      rl.on("error", (err) => finish(() => reject(err)));
      rl.on("close", () => finish(() => resolve("")));
      rl.question("", (answer) => finish(() => resolve(answer)));
    });
  }

  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buf = "";
    let settled = false;
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    // Forward-declared so onData/onError can reference it; assigned below once
    // onData and onError exist (to remove every listener we add).
    let cleanup = () => {};

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === CTRL_D) {
          // Enter or Ctrl-D (EOF): finish the line.
          output.write("\n");
          finish(() => resolve(buf));
          return;
        }
        if (ch === CTRL_C) {
          // Ctrl-C: abort cleanly (raw mode suppresses the usual SIGINT).
          output.write("\n");
          finish(() => reject(new Error("Aborted.")));
          return;
        }
        if (ch === DEL || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        // Ignore other control characters; append printable input.
        if (ch >= " ") buf += ch;
      }
    };

    const onError = (err: Error) => finish(() => reject(err));

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      input.pause();
    };

    input.on("data", onData);
    input.on("error", onError);
  });
}
