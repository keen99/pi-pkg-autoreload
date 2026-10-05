#!/usr/bin/env node
// Deep pinned-pi smoke for pkg-autoreload. Boots real pi in RPC mode with the
// extension loaded and asserts the extension actually did its job on the real
// process: enable token armed, session_start fired, and — critically — the
// InteractiveMode.handleReloadCommand patch installed (the extension's whole
// purpose; silently skipped if pi internals move). Unit tests cover the rest.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-autoreload-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
const LOG = join(agentDir, 'pi-pkg-autoreload', 'debug.log');

// Tell the extension which exact pi install to patch — the one we spawned.
// .ts extensions run in pi's loader worker where argv-based discovery breaks,
// so the harness pins the root explicitly. Real npm -g installs are covered
// by the extension's execPath-derived global-path resolution.
function piPkgRootFromBin(bin) {
	let p;
	try { p = realpathSync(bin); } catch { return undefined; }
	let dir = dirname(p);
	for (let i = 0; i < 12; i++) {
		const pj = join(dir, 'package.json');
		if (existsSync(pj)) {
			try {
				if (JSON.parse(readFileSync(pj, 'utf8')).name === '@earendil-works/pi-coding-agent') return dir;
			} catch { /* keep walking */ }
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return undefined;
}
const pkgRoot = piPkgRootFromBin(process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'));

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PKG_ROOT: pkgRoot ?? '' }, cwd: dir },
);
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const t0 = Date.now();
const hard = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	let logText = '';
	try { logText = readFileSync(LOG, 'utf8'); } catch { /* not yet */ }
	const armed = logText.includes('default export: enable token armed');
	const patched = logText.includes('patch: wrapper installed');
	const skipLine = logText.split('\n').find((l) => l.includes('patch: no ') || l.includes('patch: skip'));
	if (armed && patched) finish(true, logText, skipLine);
	else if (Date.now() - t0 > 20_000) finish(false, logText, skipLine);
}, 200);

function finish(ok, logText, skipLine) {
	clearInterval(poll);
	clearTimeout(hard);
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(hard);
		try {
			if (!ok) {
				throw new Error(
					`timed out. armed=${logText.includes('enable token armed')} patched=${logText.includes('wrapper installed')}` +
					(skipLine ? ` — ${skipLine}` : '') + `; stderr tail: ${out.slice(-600)}`,
				);
			}
			console.log(`Deep smoke PASS: token armed + handleReloadCommand patched in real pi (${(Date.now() - t0) / 1000 | 0}s).`);
			process.exit(0);
		} catch (e) {
			console.error('FAIL', e.message);
			try { console.error('log:', logText); } catch { /* none */ }
			process.exitCode = 1;
			process.exit(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
