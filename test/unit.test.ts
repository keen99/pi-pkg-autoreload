import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  gitSourcePath,
  collectGitPackages,
  collectNpmPackages,
  readSettingsSources,
  findStaleNpm,
  findStaleGit,
  isGitDirty,
} from "../index.js";

let tmpAgent = "";
let tmpProject = "";

function useTempAgent(): string {
  tmpAgent = mkdtempSync(join(tmpdir(), "pi-autoreload-agent-"));
  process.env.PI_CODING_AGENT_DIR = tmpAgent;
  return tmpAgent;
}

function gitDir(p: string): void {
  mkdirSync(p, { recursive: true });
  mkdirSync(join(p, ".git"), { recursive: true });
}

function cleanup(): void {
  delete process.env.PI_CODING_AGENT_DIR;
  if (tmpAgent) rmSync(tmpAgent, { recursive: true, force: true });
  if (tmpProject) rmSync(tmpProject, { recursive: true, force: true });
}

// ---------- gitSourcePath ----------
test("gitSourcePath: short host form", () => {
  assert.equal(gitSourcePath("git:github.com/owner/repo"), "github.com/owner/repo");
});
test("gitSourcePath: scp form", () => {
  assert.equal(gitSourcePath("git:git@github.com:owner/repo"), "github.com/owner/repo");
});
test("gitSourcePath: ssh:// form", () => {
  assert.equal(gitSourcePath("git:ssh://git@github.com/owner/repo"), "github.com/owner/repo");
});
test("gitSourcePath: https URL", () => {
  assert.equal(gitSourcePath("git:https://github.com/owner/repo"), "github.com/owner/repo");
});
test("gitSourcePath: .git suffix stripped", () => {
  assert.equal(gitSourcePath("git:github.com/owner/repo.git"), "github.com/owner/repo");
});
test("gitSourcePath: @ref pin stripped", () => {
  assert.equal(gitSourcePath("git:github.com/owner/repo@abc123"), "github.com/owner/repo");
});
test("gitSourcePath: query string stripped", () => {
  assert.equal(gitSourcePath("git:github.com/owner/repo?x=1"), "github.com/owner/repo");
});
test("gitSourcePath: extra path segments rejected", () => {
  assert.equal(gitSourcePath("git:github.com/owner/repo/extra"), undefined);
});
test("gitSourcePath: bare owner rejected", () => {
  assert.equal(gitSourcePath("git:owner"), undefined);
});

// ---------- collectGitPackages ----------
test("collectGitPackages: user+project, dedupe, pinned skip, .git required", () => {
  const agent = useTempAgent();
  tmpProject = mkdtempSync(join(tmpdir(), "pi-autoreload-proj-"));
  gitDir(join(agent, "git", "github.com", "owner", "alpha"));
  gitDir(join(agent, "git", "github.com", "owner", "beta"));
  gitDir(join(agent, "git", "github.com", "owner", "ghost")); // not in settings
  mkdirSync(join(tmpProject, ".pi"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    packages: ["git:github.com/owner/alpha", "git:github.com/owner/beta@v1", "npm:something"],
  }), "utf-8");
  writeFileSync(join(tmpProject, ".pi", "settings.json"), JSON.stringify({
    packages: ["git:github.com/owner/alpha"], // dupe
  }), "utf-8");
  const out = collectGitPackages(tmpProject);
  assert.deepEqual(out, [{ source: "git:github.com/owner/alpha", dir: join(agent, "git/github.com/owner/alpha") }]);
  cleanup();
});

test("collectGitPackages: object-form sources and disabled list ignored", () => {
  const agent = useTempAgent();
  gitDir(join(agent, "git", "github.com", "owner", "live"));
  gitDir(join(agent, "git", "github.com", "owner", "off"));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    packages: [{ source: "git:github.com/owner/live" }],
    disabledpackages: ["git:github.com/owner/off"],
  }), "utf-8");
  const out = collectGitPackages(tmpProject ?? process.cwd());
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "git:github.com/owner/live");
  cleanup();
});

// ---------- collectNpmPackages ----------
test("collectNpmPackages: unpinned only, versioned skipped, scoped kept", () => {
  const agent = useTempAgent();
  const npmDir = join(agent, "npm");
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(join(npmDir, "package.json"), JSON.stringify({ dependencies: {} }), "utf-8");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    packages: ["npm:pi-notify", "npm:pi-notify@1.2.3", "npm:@scope/pkg", "npm:@scope/pkg@2.0.0"],
  }), "utf-8");
  const out = collectNpmPackages(tmpProject ?? process.cwd());
  assert.deepEqual(out.map((p) => p.name).sort(), ["@scope/pkg", "pi-notify"]);
  cleanup();
});

test("collectNpmPackages: missing npm install dir -> empty", () => {
  useTempAgent();
  writeFileSync(join(tmpAgent, "settings.json"), JSON.stringify({ packages: ["npm:pi-notify"] }), "utf-8");
  assert.deepEqual(collectNpmPackages(tmpProject ?? process.cwd()), []);
  cleanup();
});

// ---------- readSettingsSources ----------
test("readSettingsSources: both lists, npm pin stripped, git normalized", () => {
  useTempAgent();
  writeFileSync(join(tmpAgent, "settings.json"), JSON.stringify({
    packages: ["npm:pi-notify@1.2.3", "git:git@github.com:owner/repo"],
    disabledpackages: ["npm:pi-caveman", "git:github.com/owner/off"],
  }), "utf-8");
  const src = readSettingsSources(tmpProject ?? process.cwd());
  assert.deepEqual([...src.npm].sort(), ["pi-caveman", "pi-notify"]);
  assert.deepEqual([...src.git].sort(), ["github.com/owner/off", "github.com/owner/repo"]);
  cleanup();
});

// ---------- findStaleNpm ----------
test("findStaleNpm: not-in-settings stale, transitive dep protected", () => {
  const agent = useTempAgent();
  const npmDir = join(agent, "npm");
  mkdirSync(join(npmDir, "node_modules", "active-pkg"), { recursive: true });
  writeFileSync(join(npmDir, "package.json"), JSON.stringify({
    dependencies: { "active-pkg": "^1.0.0", "stray-pkg": "^1.0.0", "some-transitive": "^1.0.0" },
  }), "utf-8");
  writeFileSync(join(npmDir, "node_modules", "active-pkg", "package.json"), JSON.stringify({
    dependencies: { "some-transitive": "^2.0.0" },
  }), "utf-8");
  const stale = findStaleNpm(tmpProject ?? process.cwd(), new Set(["active-pkg"]));
  assert.deepEqual(stale, [{ name: "stray-pkg", reason: "not in settings" }]);
  cleanup();
});

// ---------- findStaleGit ----------
test("findStaleGit: clone without settings entry flagged, active kept", () => {
  const agent = useTempAgent();
  gitDir(join(agent, "git", "github.com", "owner", "kept"));
  gitDir(join(agent, "git", "github.com", "owner", "gone"));
  mkdirSync(join(agent, "git", "github.com", "owner", "stray-file"), { recursive: true });
  appendFileSync(join(agent, "git", "github.com", "owner", "stray-file", "x"), "f"); // no .git -> skip
  const stale = findStaleGit(new Set(["github.com/owner/kept"]));
  assert.deepEqual(stale, [{ dir: join(agent, "git/github.com/owner/gone"), source: "github.com/owner/gone", reason: "not in settings" }]);
  cleanup();
});

// ---------- isGitDirty (real git subprocesses) ----------
function realGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pi-autoreload-repo-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  execSync("git add tracked.txt && git commit -qm init", { cwd: repo });
  return repo;
}
test("isGitDirty: clean repo false", () => {
  const repo = realGitRepo();
  assert.equal(isGitDirty(repo), false);
  rmSync(repo, { recursive: true, force: true });
});
test("isGitDirty: tracked modification true", () => {
  const repo = realGitRepo();
  writeFileSync(join(repo, "tracked.txt"), "v2\n");
  assert.equal(isGitDirty(repo), true);
  rmSync(repo, { recursive: true, force: true });
});
test("isGitDirty: untracked-only (npm artifacts) false", () => {
  const repo = realGitRepo();
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "junk.js"), "x");
  writeFileSync(join(repo, "package-lock.json"), "{}");
  assert.equal(isGitDirty(repo), false);
  rmSync(repo, { recursive: true, force: true });
});
test("isGitDirty: staged change true", () => {
  const repo = realGitRepo();
  writeFileSync(join(repo, "tracked.txt"), "v3\n");
  execSync("git add tracked.txt", { cwd: repo });
  assert.equal(isGitDirty(repo), true);
  rmSync(repo, { recursive: true, force: true });
});
