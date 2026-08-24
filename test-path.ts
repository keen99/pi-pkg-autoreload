// Test gitSourcePath via esbuild transpile (regex stripping breaks on TS
// non-null assertions). Run: npx -y tsx test-path.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const root = new URL(".", import.meta.url).pathname;
execFileSync("npx", ["-y", "esbuild", "index.ts", "--outfile=/tmp/ar-test.cjs", "--format=cjs"], {
	cwd: root,
	stdio: "ignore",
});
const js = fs.readFileSync("/tmp/ar-test.cjs", "utf8");
const gitFn = js.match(/function gitSourcePath[\s\S]*?\n\}/)?.[0];
if (!gitFn) throw new Error("gitSourcePath not found in transpiled output");
const gitSourcePath = new Function(`${gitFn}; return gitSourcePath;`)() as (
	s: string,
) => string | undefined;

type Case = [input: string, want: string | undefined];
const cases: Case[] = [
	["git:git@github.com:keen99/pi-git-guard", "github.com/keen99/pi-git-guard"],
	["git:git@github.com:keen99/pi-git-guard.git", "github.com/keen99/pi-git-guard"],
	["git:github.com/keen99/pi-git-guard", "github.com/keen99/pi-git-guard"],
	["git:https://github.com/keen99/pi-git-guard", "github.com/keen99/pi-git-guard"],
	["git:ssh://git@github.com/keen99/pi-git-guard", "github.com/keen99/pi-git-guard"],
	["git:git@github.com:keen99/pi-ollama@94103da", "github.com/keen99/pi-ollama"],
	["git:github.com/CaptCanadaMan/pi-ollama@94103da", "github.com/CaptCanadaMan/pi-ollama"],
	["git:git@github.com:keen99/foo?subdir=x", "github.com/keen99/foo"],
	["git:weird", undefined],
	["git:git@github.com:onlyowner", undefined],
];

let fail = 0;
for (const [input, want] of cases) {
	const got = gitSourcePath(input);
	const ok = got === want;
	if (!ok) fail++;
	console.log(`${ok ? "PASS" : "FAIL"} ${input} -> ${got}${ok ? "" : ` want ${want}`}`);
}
if (fail) process.exit(1);
console.log(`ALL ${cases.length} PASS`);
