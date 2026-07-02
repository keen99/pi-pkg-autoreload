import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const GIT_PKGS_DIR = join(AGENT_DIR, "git");

const piRoot = (function (): string {
  try {
    return require.resolve("@earendil-works/pi-coding-agent/package.json")
      .replace(/\/package\.json$/, "");
  } catch {
    const main = require.resolve("@earendil-works/pi-coding-agent");
    return main.replace(/\/dist\/.*$/, "");
  }
})();
const imPath = piRoot
  ? join(piRoot, "dist", "modes", "interactive", "interactive-mode.js")
  : "";

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

  // Resolve the TRUE original (pi's real handleReloadCommand).
  // Cache it on globalThis once at first-ever install. Subsequent unwraps
  // always resolve to the real ORIG, never a prior wrapper — prevents
  // stacking a chain of wrappers that double-run git pulls.
  const GLOBAL_ORIG = "__piPkgAutoreloadTrueOriginal";
  let trueOriginal = original;
  if ((original as any).__piPkgAutoreload) {
    const cached = (globalThis as any)[GLOBAL_ORIG];
    if (typeof cached === "function") {
      trueOriginal = cached;
    } else {
      const stored = (original as any).__piPkgAutoreloadOriginal;
      if (typeof stored === "function") trueOriginal = stored;
    }
  }
  if (!(globalThis as any)[GLOBAL_ORIG]) {
    (globalThis as any)[GLOBAL_ORIG] = trueOriginal;
  }

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
    // Enable-token: consumed on each /reload. If autoreload wasn't loaded
    // this cycle (removed from packages), passthrough to true reload.
    const FLAG = "__piPkgAutoreloadEnabled";
    const enabled = (globalThis as any)[FLAG] === true;
    (globalThis as any)[FLAG] = false;
    if (!enabled) return trueOriginal.call(this);

    const cwd = this.sessionManager?.getCwd?.() ?? process.cwd();
    const packages = collectGitPackages(cwd);
    if (packages.length === 0) {
      return trueOriginal.call(this);
    }

    // Tiny repos, network cheap — pull all in parallel.
    const CONCURRENCY = Math.max(8, packages.length);
    let updated = 0;
    let failed = 0;
    const failures: string[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < packages.length) {
        const localIdx = idx++;
        if (localIdx >= packages.length) break;
        const pkg = packages[localIdx];
        if (!pkg) break;
        const result = await pullPkg(pkg);
        if (result.ok) {
          updated++;
        } else {
          failed++;
          failures.push(`${pkg.source}: ${result.msg}`);
        }
      }
    };

    try {
      this.showStatus?.(`autoreload: pulling ${packages.length} packages…`);
    } catch {
      /* swallow */
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, packages.length) }, () => worker()),
    );

    try {
      const summary = `autoreload: ${updated} updated${failed > 0 ? `, ${failed} failed` : ""}`;
      this.showStatus?.(failed > 0 ? `${summary} — ${failures.join("; ")}` : summary);
    } catch {
      /* swallow */
    }
    // Now reload as normal — files on disk include any pulled updates.
    return trueOriginal.call(this);
  };
  (proto.handleReloadCommand as any).__piPkgAutoreload = true;
  (proto.handleReloadCommand as any).__piPkgAutoreloadOriginal = trueOriginal;
  patched = true;
}

export default function (pi: ExtensionAPI) {
  // Re-arm the enable token. Consumed by the wrapper on next /reload.
  (globalThis as any)["__piPkgAutoreloadEnabled"] = true;
  pi.on("session_start", async () => {
    if (!InteractiveMode && imPath) {
      try {
        const mod = (await import(imPath)) as {
          InteractiveMode?: new (...args: unknown[]) => unknown;
        };
        InteractiveMode = mod.InteractiveMode;
      } catch {
        // import failed — leave InteractiveMode undefined, patch() no-ops
      }
    }
    patch();
  });
}
