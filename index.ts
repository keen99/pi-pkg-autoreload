/**
 * pi-pkg-autoreload
 *
 * Monkeypatches pi's InteractiveMode.handleReloadCommand to git-pull all
 * configured git packages BEFORE reloading. So /reload actually picks up
 * remote changes without a manual `pi update` or `git pull` step.
 *
 * Problem: pi's /reload only rereads files from disk. For git packages that
 * means it picks up whatever is in ~/.pi/agent/git/<owner>/<repo>/, NOT the
 * latest remote. After `git push`, a /reload in a live session silently does
 * nothing — you must exit, `pi update`, relaunch. That is the "extra step"
 * friction for every git package.
 *
 * Local extensions don't have this problem because edits land directly on disk.
 * This extension closes the gap so git packages behave the same way on reload.
 *
 * How: import InteractiveMode from the installed dist, save its
 * handleReloadCommand prototype method, replace with a wrapper that:
 *   1. collects git packages from settings.json (user + project scopes)
 *   2. runs `git pull` in each package dir (best-effort, errors notified)
 *   3. calls the original handleReloadCommand()
 *
 * Scope: interactive mode only (that's where /reload lives). No effect in
 * print/rpc modes.
 *
 * Zero config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Resolve InteractiveMode module from the GLOBAL pi install — not the
// extension's own node_modules. Patching the local peerDep copy does nothing
// because pi runtime uses the global module object. Module identity matters:
// prototype patch must land on the same class object pi actually instantiates.
//
// Strategy: resolve via `npm root -g` (sync, no deps). Falls back to walking up
// from this file's node_modules chain (dev/link scenarios).
const here = dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

const AGENT_DIR = join(homedir(), ".pi", "agent");
const GIT_PKGS_DIR = join(AGENT_DIR, "git");

function resolveGlobalPiRoot(): string | undefined {
  // 1. npm root -g (most reliable for global installs)
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const candidate = join(npmRoot, "@earendil-works", "pi-coding-agent");
    const imExists = existsSync(join(candidate, "dist", "modes", "interactive", "interactive-mode.js"));
    if (imExists) return candidate;
  } catch {
    /* fall through */
  }
  // 2. Common nvm/volta paths from NODE_PATH / process.execPath
  try {
    const binDir = dirname(process.execPath); // .../bin
    const libDir = join(dirname(binDir), "lib", "node_modules");
    const candidate = join(libDir, "@earendil-works", "pi-coding-agent");
    const imExists = existsSync(join(candidate, "dist", "modes", "interactive", "interactive-mode.js"));
    if (imExists) return candidate;
  } catch {
    /* fall through */
  }
  return undefined;
}

const piRoot = resolveGlobalPiRoot();
const imPath = piRoot
  ? join(piRoot, "dist", "modes", "interactive", "interactive-mode.js")
  : undefined;

// Use dynamic import() at session_start — NOT createRequire. pi runtime
// imports this module as ESM. require() = separate CJS module registry =
// separate prototype = patch lands on wrong object. import() shares pi's
// ESM module instance.
let InteractiveMode: (new (...args: unknown[]) => unknown) | undefined;

let patched = false;

interface GitPackage {
  source: string; // full source string like "git:github.com/owner/repo"
  dir: string; // ~/.pi/agent/git/<owner>/<repo>
}

/** Collect git package install dirs from settings.json (user + project). */
function collectGitPackages(cwd: string): GitPackage[] {
  const out: GitPackage[] = [];
  const seen = new Set<string>();

  const settingsFiles = [
    join(AGENT_DIR, "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];

  for (const file of settingsFiles) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let settings: { packages?: unknown[] };
    try {
      settings = JSON.parse(raw);
    } catch {
      continue;
    }
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    for (const pkg of packages) {
      const src = typeof pkg === "string" ? pkg : (pkg as { source?: string })?.source;
      if (typeof src !== "string" || !src.startsWith("git:")) continue;

      // git:github.com/owner/repo -> owner/repo
      const rest = src.slice("git:".length);
      // strip ref/query suffixes
      const path = rest.replace(/[?#].*$/, "").replace(/^([^/]+\/[^/]+)@.*$/, "$1");
      const dir = join(GIT_PKGS_DIR, path);
      if (!existsSync(join(dir, ".git"))) continue;
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push({ source: src, dir });
    }
  }
  return out;
}

function patch(): void {
  if (patched) return;
  if (!InteractiveMode) return;
  const proto = InteractiveMode.prototype as {
    handleReloadCommand?: () => Promise<void>;
  };
  const original = proto.handleReloadCommand;
  if (typeof original !== "function") return;

  // Spawn git pull non-blocking with hard timeout. execSync blocks TUI render
  // loop; a single hung repo (auth prompt, network) freezes pi indefinitely.
  const pullPkg = (pkg: GitPackage): Promise<{ ok: boolean; msg: string }> =>
    new Promise((resolve) => {
      const { spawn } = require("child_process") as typeof import("child_process");
      const child = spawn("git", ["pull", "--ff-only"], {
        cwd: pkg.dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill("SIGKILL");
        resolve({ ok: false, msg: "timeout (30s)" });
      }, 30_000);
      child.on("error", (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, msg: err.message });
      });
      child.on("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true, msg: "" });
        else resolve({ ok: false, msg: stderr.trim() || `exit ${code}` });
      });
    });

  proto.handleReloadCommand = async function (this: {
    showStatus?: (msg: string) => void;
    sessionManager?: { getCwd?: () => string };
    session?: { modelRegistry?: unknown };
  }) {
    const cwd = this.sessionManager?.getCwd?.() ?? process.cwd();
    const packages = collectGitPackages(cwd);
    if (packages.length === 0) {
      return original.call(this);
    }

    // Bounded parallel: 6 concurrent pulls. Serial wastes network idle time;
    // unbounded floods connections.
    const CONCURRENCY = 6;
    let done = 0;
    let updated = 0;
    let failed = 0;
    const failures: string[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < packages.length) {
        const pkg = packages[idx++];
        if (!pkg) break;
        const result = await pullPkg(pkg);
        done++;
        if (result.ok) {
          updated++;
        } else {
          failed++;
          failures.push(`${pkg.source}: ${result.msg}`);
        }
        try {
          this.showStatus?.(`autoreload: ${done}/${packages.length} (${updated} up, ${failed} fail)`);
        } catch {
          /* swallow */
        }
      }
    };
    try {
      this.showStatus?.(`autoreload: pulling ${packages.length} packages…`);
    } catch {
      /* swallow */
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, packages.length) }, () => worker()));

    try {
      const summary = `autoreload: ${updated} updated, ${failed} failed`;
      this.showStatus?.(failed > 0 ? `${summary} — ${failures.join("; ")}` : summary);
    } catch {
      /* swallow */
    }
    // Now reload as normal — files on disk include any pulled updates.
    return original.call(this);
  };
  patched = true;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    if (!InteractiveMode && imPath) {
      try {
        const mod = (await import(imPath)) as {
          InteractiveMode?: new (...args: unknown[]) => unknown;
        };
        InteractiveMode = mod.InteractiveMode;
      } catch (err) {
        // import failed — leave InteractiveMode undefined, patch() no-ops
      }
    }
    patch();
  });
}
