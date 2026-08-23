// Test harness for gitSourcePath — extracted from index.ts, run via tsx.
// Avoids importing index.ts (its module-scope require.resolve breaks ESM import).
import * as fs from "node:fs";

const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const fnSource = src.match(/function gitSourcePath[\s\S]*?\n\}/)?.[0];
if (!fnSource) throw new Error("gitSourcePath not found in index.ts");
// Strip TS annotations crudely: return type only. Args stay typed-safe by
// running through tsx transpile instead — simplest: write test as plain TS
// importing nothing, inlining function via esbuild-free regex: replace only
// the signature annotation.
const jsSource = fnSource.replace(/^function gitSourcePath\(src: string\): string \| undefined \{/, "function gitSourcePath(src) {");
if (jsSource === fnSource) throw new Error("signature strip failed");
const gitSourcePath = new Function(`${jsSource}; return gitSourcePath;`)() as (
	s: string,
) => string | undefined;

type Case = [input: string, want: string | undefined];
const cases: Case[] = [
	["git:git@github.com:keen99/pi-git-guard", "keen99/pi-git-guard"],
	["git:git@github.com:keen99/pi-git-guard.git", "keen99/pi-git-guard"],
	["git:github.com/keen99/pi-git-guard", "keen99/pi-git-guard"],
	["git:https://github.com/keen99/pi-git-guard", "keen99/pi-git-guard"],
	["git:ssh://git@github.com/keen99/pi-git-guard", "keen99/pi-git-guard"],
	["git:git@github.com:keen99/pi-ollama@94103da", "keen99/pi-ollama"],
	["git:github.com/CaptCanadaMan/pi-ollama@94103da", "CaptCanadaMan/pi-ollama"],
	["git:git@github.com:keen99/foo?subdir=x", "keen99/foo"],
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
