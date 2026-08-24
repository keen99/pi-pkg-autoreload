import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const GIT_PKGS_DIR = join(AGENT_DIR, "git");
const LOG_DIR = join(AGENT_DIR, "pi-pkg-autoreload");
const LOG_FILE = join(LOG_DIR, "debug.log");
/** Attention lines persisted for re-show after reload (widget dies with session). */
const ATTENTION_FILE = join(LOG_DIR, "last-attention.json");

const LOG_MAX_BYTES = 512 * 1024; // 512 KB, rotate to .old

function log(msg: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        try { rmSync(`${LOG_FILE}.old`, { force: true }); } catch { /* ignore */ }
        try { renameSync(LOG_FILE, `${LOG_FILE}.old`); } catch { /* ignore */ }
      }
    } catch { /* no file yet */ }
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch { /* ignore */ }
}

log("=== ext module loaded ===");

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

/** Normalize a git: source to "host/owner/repo" or undefined.
 *  Handles github.com/owner/repo, git@github.com:owner/repo,
 *  ssh://git@github.com/owner/repo, https://github.com/owner/repo,
 *  .git suffixes, and @ref pins. Host kept — install dirs are
 *  ~/.pi/agent/git/<host>/<owner>/<repo>. */
function gitSourcePath(src: string): string | undefined {
  const rest = src.replace(/^git:/, "").replace(/[?#].*$/, "");
  let path = rest;
  let host = "";
  const scp = path.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else if (/^ssh:\/\/git@([^/]+)\//.test(path)) {
    host = path.match(/^ssh:\/\/git@([^/]+)\//)![1];
    path = path.replace(/^ssh:\/\/git@[^/]+\//, "");
  } else if (/^https?:\/\/([^/]+)\//.test(path)) {
    host = path.match(/^https?:\/\/([^/]+)\//)![1];
    path = path.replace(/^https?:\/\/[^/]+\//, "");
  } else {
    const short = path.match(/^([^/]+)\/(.+)$/);
    if (short) {
      host = short[1];
      path = short[2];
    }
  }
  path = path.replace(/\.git$/, "");
  path = path.replace(/^([^/]+\/[^/]+)@.*$/, "$1");
  if (!host || !/^[^/]+\/[^/]+$/.test(path)) return undefined;
  return `${host}/${path}`;
}
export { gitSourcePath };

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

      // Normalize every form to owner/repo via gitSourcePath.
      // Pinned refs (@ref) are frozen intentionally — skip pulls.
      if (/^[^/]+\/[^/]+@/.test(src.slice("git:").replace(/[?#].*$/, ""))) continue;
      const pathNoQuery = gitSourcePath(src);
      if (!pathNoQuery) continue;
      const dir = join(GIT_PKGS_DIR, pathNoQuery);
      if (!existsSync(join(dir, ".git"))) continue;
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push({ source: src, dir });
    }
  }
  return out;
}

const NPM_INSTALL_DIR = join(AGENT_DIR, "npm");

interface NpmPackage {
  source: string; // full source string like "npm:@scope/pkg"
  name: string; // npm package name, no "npm:" prefix
}

/** Collect npm package sources from settings.json (user + project).
 *  Skips versioned specs (pinned) — those are intentionally frozen. */
function collectNpmPackages(cwd: string): NpmPackage[] {
  const out: NpmPackage[] = [];
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
      if (typeof src !== "string" || !src.startsWith("npm:")) continue;

      // npm:@scope/pkg@1.2.3 -> skip pinned. npm:@scope/pkg -> name only.
      const rest = src.slice("npm:".length);
      if (rest.includes("@") && !rest.startsWith("@")) continue; // versioned, pinned
      // scoped: @scope/pkg never starts with version; only @ after slash = pin
      const atIdx = rest.indexOf("@", 1);
      if (atIdx !== -1) continue; // version suffix present

      const name = rest;
      if (!existsSync(join(NPM_INSTALL_DIR, "package.json"))) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ source: src, name });
    }
  }
  return out;
}

interface StaleNpm { name: string; reason: string }
interface StaleGit { dir: string; source: string; reason: string }

/** Read all package sources from settings (user+project, packages+disabledpackages). */
function readSettingsSources(cwd: string): { npm: Set<string>; git: Set<string> } {
  const npm = new Set<string>();
  const git = new Set<string>();
  const files = [join(AGENT_DIR, "settings.json"), join(cwd, ".pi", "settings.json")];
  for (const file of files) {
    let raw: string;
    try { raw = readFileSync(file, "utf-8"); } catch { continue; }
    let s: { packages?: unknown[]; disabledpackages?: unknown[] };
    try { s = JSON.parse(raw); } catch { continue; }
    for (const list of [s.packages, s.disabledpackages]) {
      if (!Array.isArray(list)) continue;
      for (const pkg of list) {
        const src = typeof pkg === "string" ? pkg : (pkg as { source?: string })?.source;
        if (typeof src !== "string") continue;
        if (src.startsWith("npm:")) {
          const rest = src.slice("npm:".length);
          const atIdx = rest.indexOf("@", 1);
          npm.add(atIdx === -1 ? rest : rest.slice(0, atIdx));
        } else if (src.startsWith("git:")) {
          const path = gitSourcePath(src);
          if (path) git.add(path);
        }      }
    }
  }
  return { npm, git };
}

/** Find npm pkgs installed as top-level deps but not in settings.
 *  Protects transitive deps of active packages. */
function findStaleNpm(cwd: string, activeNpm: Set<string>): StaleNpm[] {
  const stale: StaleNpm[] = [];
  const pkgFile = join(NPM_INSTALL_DIR, "package.json");
  let raw: string;
  try { raw = readFileSync(pkgFile, "utf-8"); } catch { return stale; }
  let deps: Record<string, string>;
  try { deps = (JSON.parse(raw) as { dependencies?: Record<string,string> }).dependencies ?? {}; }
  catch { return stale; }

  const required = new Set<string>();
  for (const name of activeNpm) {
    try {
      const depPkg = JSON.parse(readFileSync(join(NPM_INSTALL_DIR, "node_modules", name, "package.json"), "utf-8")) as { dependencies?: Record<string,string> };
      for (const d of Object.keys(depPkg.dependencies ?? {})) required.add(d);
    } catch { /* missing, skip */ }
  }

  for (const name of Object.keys(deps)) {
    if (activeNpm.has(name)) continue;
    if (required.has(name)) { stale.push({ name, reason: "transitive dep" }); continue; }
    stale.push({ name, reason: "not in settings" });
  }
  return stale;
}

/** Find git clones on disk but source removed from settings. */
function findStaleGit(activeGit: Set<string>): StaleGit[] {
  const stale: StaleGit[] = [];
  const hosts = ["github.com", "gitlab.com", "bitbucket.org"];
  for (const host of hosts) {
    const hostDir = join(GIT_PKGS_DIR, host);
    let owners: string[];
    try { owners = readdirSync(hostDir); } catch { continue; }
    for (const owner of owners) {
      const ownerDir = join(hostDir, owner);
      let repos: string[];
      try { repos = readdirSync(ownerDir); } catch { continue; }
      for (const repo of repos) {
        const dir = join(ownerDir, repo);
        try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
        if (!existsSync(join(dir, ".git"))) continue;
        const path = `${host}/${owner}/${repo}`;
        if (activeGit.has(path)) continue;
        stale.push({ dir, source: path, reason: "not in settings" });
      }
    }
  }
  return stale;
}

/** Check git working tree has real modifications.
 *  Pi npm-installs deps inside each git clone (node_modules, package-lock.json),
 *  so untracked npm artifacts are normal state, not "dirty". Only tracked-file
 *  changes (M/A/D/R lines) count — matching pi's own update behavior, which
 *  reset --hard + clean -fdx and reinstalls. */
function isGitDirty(dir: string): boolean {
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    const out = execSync("git status --porcelain", { cwd: dir, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString();
    // " M file" (worktree mod), "M  file" (staged), "A ", "D ", "R " modify
    // tracked content. "??" lines are untracked (node_modules etc).
    return out
      .split("\n")
      .some((line) => line.trim().length > 0 && !line.trim().startsWith("??"));
  } catch { return true; } // assume dirty if check fails
}

function patch(): void {
  if (patched) { log("patch: already patched, skip"); return; }
  if (!InteractiveMode) { log("patch: no InteractiveMode, skip"); return; }
  const proto = InteractiveMode.prototype as {
    handleReloadCommand?: () => Promise<void>;
  };
  const original = proto.handleReloadCommand;
  if (typeof original !== "function") { log("patch: no handleReloadCommand on proto, skip"); return; }
  log("patch: installing wrapper");

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
      // Normalize origin URL: ensure .git suffix on github SSH/HTTPS remotes.
      // pi cloned some repos without .git, breaking fetch.
      const fixRemote =
        "current=$(git remote get-url origin 2>/dev/null) || exit 1; " +
        "case \"$current\" in " +
        "  *github.com*:*.git|*github.com*/*.git) ;; " +
        "  git@github.com:*) fixed=\"${current}.git\";; " +
        "  https://github.com/*|http://github.com/*) fixed=\"${current}.git\";; " +
        "  *) fixed=\"$current\";; " +
        "esac; " +
        "[ -n \"$fixed\" ] && [ \"$fixed\" != \"$current\" ] && git remote set-url origin \"$fixed\" || true; ";
      const child = spawn(fixRemote + "git fetch origin && git reset --hard @{u}", {
        cwd: pkg.dir,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
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

  // Silent npm install <name>@latest in pi's npm dir. Mirrors git pullPkg
  // pattern: non-blocking spawn, hard timeout, capture stderr only.
  // --no-audit --no-fund kill npm noise. --silent suppresses install table.
  const updateNpmPkg = (pkg: NpmPackage): Promise<{ ok: boolean; msg: string }> =>
    new Promise((resolve) => {
      const { spawn } = require("child_process") as typeof import("child_process");
      const child = spawn(
        `npm install ${pkg.name}@latest --no-audit --no-fund --silent --no-progress`,
        {
          cwd: NPM_INSTALL_DIR,
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
          env: { ...process.env, CI: "1", NPM_WRAPPER_ALLOW_LOCAL: "1" },
        },
      );
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill("SIGKILL");
        resolve({ ok: false, msg: "timeout (60s)" });
      }, 60_000);
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
    log(`reload: invoked, enabled=${enabled}`);
    if (!enabled) { log("reload: not enabled, passthrough"); return trueOriginal.call(this); }

    const cwd = this.sessionManager?.getCwd?.() ?? process.cwd();
    const gitPackages = collectGitPackages(cwd);
    const npmPackages = collectNpmPackages(cwd);

    // Cleanup phase: detect stale installs (not in settings, not transitive dep).
    const settingsSrc = readSettingsSources(cwd);
    const staleNpm = findStaleNpm(cwd, settingsSrc.npm);
    const staleGit = findStaleGit(settingsSrc.git);
    log(`reload: cleanup scan — ${staleNpm.length} stale npm, ${staleGit.length} stale git`);

    type State = "pending" | "working" | "done" | "failed" | "skipped";
    interface Row { source: string; kind: "clean" | "git" | "npm"; state: State; msg?: string }
    const WIDGET_KEY = "pkg-autoreload";
    const rows: Row[] = [];
    // cleanup rows first
    for (const s of staleNpm) rows.push({ source: s.name, kind: "clean", state: "pending", msg: s.reason });
    for (const s of staleGit) rows.push({ source: s.source, kind: "clean", state: "pending", msg: s.reason });
    // then update rows
    rows.push(...gitPackages.map(p => ({ source: p.source, kind: "git" as const, state: "pending" as State })));
    rows.push(...npmPackages.map(p => ({ source: p.source, kind: "npm" as const, state: "pending" as State })));
    const renderWidget = () => {
      try {
        const lines = rows.map(p => {
          const name = p.source.replace(/^(git:|npm:)/, "");
          const tag = p.kind === "git" ? "git" : p.kind === "npm" ? "npm" : "clean";
          const icon = p.state === "done" ? "✓" : p.state === "failed" ? "✗" : p.state === "working" ? "⏳" : p.state === "skipped" ? "~" : "·";
          const detail = p.msg ? ` ${p.msg}` : "";
          return `${icon} ${name} ${tag}${detail}`;
        });
        (this as any).setExtensionWidget?.(WIDGET_KEY, lines, { placement: "belowEditor" });
      } catch { /* best-effort */ }
    };
    renderWidget();

    let updated = 0;
    let failed = 0;
    let cleaned = 0;
    const failures: string[] = [];

    // Cleanup: npm uninstall stale, rm stale git clones (skip if dirty).
    const cleanupNpmPkg = (name: string): Promise<{ ok: boolean; msg: string }> =>
      new Promise((resolve) => {
        const { spawn } = require("child_process") as typeof import("child_process");
        const child = spawn(
          `npm uninstall ${name} --silent --no-audit --no-fund`,
          { cwd: NPM_INSTALL_DIR, stdio: ["ignore", "pipe", "pipe"], shell: true, env: { ...process.env, CI: "1", NPM_WRAPPER_ALLOW_LOCAL: "1" } },
        );
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += d.toString(); });
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          child.kill("SIGKILL");
          resolve({ ok: false, msg: "timeout (60s)" });
        }, 60_000);
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

    // Run cleanup serially (npm lock-safe, git rm quick).
    let rowIdx = 0;
    for (const s of staleNpm) {
      const ri = rowIdx++;
      rows[ri].state = "working";
      renderWidget();
      log(`cleanup npm uninstall ${s.name} (${s.reason})`);
      const r = await cleanupNpmPkg(s.name);
      if (r.ok) { cleaned++; rows[ri].state = "done"; }
      else { failed++; rows[ri].state = "failed"; rows[ri].msg = r.msg; failures.push(`npm ${s.name}: ${r.msg}`); }
      renderWidget();
    }
    for (const s of staleGit) {
      const ri = rowIdx++;
      if (isGitDirty(s.dir)) {
        rows[ri].state = "skipped"; rows[ri].msg = "dirty, keep";
        log(`cleanup git skip ${s.source} (dirty)`);
        renderWidget();
        continue;
      }
      rows[ri].state = "working";
      renderWidget();
      log(`cleanup git rm ${s.source}`);
      try { rmSync(s.dir, { recursive: true, force: true }); cleaned++; rows[ri].state = "done"; }
      catch (err) { failed++; rows[ri].state = "failed"; rows[ri].msg = (err as Error).message; failures.push(`git ${s.source}: ${(err as Error).message}`); }
      renderWidget();
    }

    // Git: parallel, tiny repos.
    let gitIdx = 0;
    const gitWorker = async () => {
      while (gitIdx < gitPackages.length) {
        const i = gitIdx++;
        if (i >= gitPackages.length) break;
        const pkg = gitPackages[i];
        if (!pkg) break;
        rows[i].state = "working";
        renderWidget();
        log(`pulling ${pkg.source} (${pkg.dir})`);
        const result = await pullPkg(pkg);
        log(`pull ${pkg.source}: ok=${result.ok} msg=${result.msg}`);
        if (result.ok) { updated++; rows[i].state = "done"; }
        else {
          failed++; rows[i].state = "failed"; rows[i].msg = result.msg;
          failures.push(`${pkg.source}: ${result.msg}`);
        }
        renderWidget();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(8, gitPackages.length), gitPackages.length || 1) }, () => gitWorker()),
    );

    // npm: serial. npm CLI not safe to parallelize against same node_modules
    // (lock contention, ERESOLVE). One at a time, silent.
    const npmOffset = gitPackages.length;
    for (let i = 0; i < npmPackages.length; i++) {
      const pkg = npmPackages[i];
      const rowIdx = npmOffset + i;
      rows[rowIdx].state = "working";
      renderWidget();
      log(`npm update ${pkg.source}`);
      const result = await updateNpmPkg(pkg);
      log(`npm ${pkg.source}: ok=${result.ok} msg=${result.msg}`);
      if (result.ok) { updated++; rows[rowIdx].state = "done"; }
      else {
        failed++; rows[rowIdx].state = "failed"; rows[rowIdx].msg = result.msg;
        failures.push(`${pkg.source}: ${result.msg}`);
      }
      renderWidget();
    }

    // Keep widget only when something needs attention (failures, dirty
    // skips). All-green run clears immediately — no residue noise.
    // Reload tears down extension widgets, so attention lines are also
    // persisted to disk and re-shown on the next session_start.
    const attentionRows = rows.filter(p => p.state === "failed" || p.state === "skipped");
    try {
      const lines = attentionRows.map(p => {
        const name = p.source.replace(/^(git:|npm:)/, "");
        const icon = p.state === "failed" ? "✗" : "~";
        const detail = p.msg ? ` ${p.msg}` : "";
        return `${icon} ${name}${detail}`;
      });
      writeFileSync(ATTENTION_FILE, JSON.stringify({ lines, at: new Date().toISOString() }), { mode: 0o600 });
    } catch { /* best-effort */ }
    await new Promise(r => setTimeout(r, 800));
    try {
      if (attentionRows.length === 0) {
        (this as any).setExtensionWidget?.(WIDGET_KEY, undefined);
      } else {
        const lines = attentionRows.map(p => {
          const name = p.source.replace(/^(git:|npm:)/, "");
          const icon = p.state === "failed" ? "✗" : "~";
          const detail = p.msg ? ` ${p.msg}` : "";
          return `${icon} ${name}${detail}`;
        });
        (this as any).setExtensionWidget?.(WIDGET_KEY, lines, { placement: "belowEditor" });
      }
    } catch { /* best-effort */ }

    try {
      const total = gitPackages.length + npmPackages.length;
      const cleanPart = cleaned > 0 ? `, ${cleaned} cleaned` : "";
      const summary = `autoreload: ${updated}/${total} updated${cleanPart}${failed > 0 ? `, ${failed} failed` : ""}`;
      log(`reload complete: ${summary}`);
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
  log("patch: wrapper installed");
}

export default function (pi: ExtensionAPI) {
  // Re-arm the enable token. Consumed by the wrapper on next /reload.
  (globalThis as any)["__piPkgAutoreloadEnabled"] = true;
  log("default export: enable token armed");
  pi.on("session_start", async () => {
    log("session_start: attempting patch");
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
    // Re-show persisted attention lines from the previous reload. Reload
    // rebuilds the TUI and drops extension widgets — this restores them.
    try {
      const raw = JSON.parse(readFileSync(ATTENTION_FILE, "utf8")) as { lines?: string[]; at?: string };
      const lines = Array.isArray(raw.lines) ? raw.lines.filter((l) => typeof l === "string") : [];
      if (lines.length > 0) {
        const ageMin = raw.at ? Math.round((Date.now() - Date.parse(raw.at)) / 60000) : 0;
        ctx.ui.setWidget("pkg-autoreload-attention", [`autoreload needs attention (${ageMin}m ago):`, ...lines]);
      }
    } catch { /* no file or bad json — nothing to show */ }
  });
}
