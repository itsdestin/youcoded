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
	fs.promises.appendFile(LOG_PATH, JSON.stringify(entry) + '\n').catch(() => {});
}

export async function rotateLog(): Promise<void> {
	try {
		const content = await fs.promises.readFile(LOG_PATH, 'utf8');
		const lines = content.split('\n');
		if (lines.length > MAX_LINES * 2) {
			const trimmed = lines.slice(-MAX_LINES).join('\n');
			const tmp = LOG_PATH + '.tmp.' + process.pid;
			await fs.promises.writeFile(tmp, trimmed);
			await fs.promises.rename(tmp, LOG_PATH);
		}
	} catch {
		// File doesn't exist yet or rotation failed — not critical
	}
}
