import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_PATH = path.join(os.homedir(), '.claude', 'desktop.log');
const MAX_LINES = 500;

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export function log(
	level: LogLevel,
	component: string,
	msg: string,
	extra?: Record<string, unknown>
): void {
	const entry = {
		ts: new Date().toISOString(),
		level,
		component,
		msg,
		pid: process.pid,
		...extra,
	};
	// 0600 on creation (security hardening 2026-10-30): the log holds file paths, session ids and
	// error text, and feeds bug reports; other accounts on the computer have no business reading it.
	fs.promises.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 }).catch(() => {});
}

export async function rotateLog(): Promise<void> {
	// An existing log made by an older build is 0644: tighten it once per launch.
	if (process.platform !== 'win32') await fs.promises.chmod(LOG_PATH, 0o600).catch(() => {});
	try {
		const content = await fs.promises.readFile(LOG_PATH, 'utf8');
		const lines = content.split('\n');
		if (lines.length > MAX_LINES * 2) {
			const trimmed = lines.slice(-MAX_LINES).join('\n');
			const tmp = LOG_PATH + '.tmp.' + process.pid;
			await fs.promises.writeFile(tmp, trimmed, { mode: 0o600 });
			await fs.promises.rename(tmp, LOG_PATH);
		}
	} catch {
		// File doesn't exist yet or rotation failed — not critical
	}
}
