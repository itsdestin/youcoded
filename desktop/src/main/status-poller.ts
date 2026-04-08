import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface StatusData {
	syncStatus: string;
	syncWarnings: string;
	lastSyncEpoch: number | null;
	syncInProgress: boolean;
	backupMeta: any;
	usage: any;
	announcement: any;
	updateStatus: any;
}

/**
 * Centralized async status poller — replaces duplicate synchronous polling
 * in ipc-handlers.ts and remote-server.ts. Polls once per interval and
 * emits 'status' events that both consumers subscribe to.
 */
export class StatusPoller extends EventEmitter {
	private interval: ReturnType<typeof setInterval> | null = null;
	private claudeDir = path.join(os.homedir(), '.claude');

	start(intervalMs = 10_000): void {
		if (this.interval) return;
		this.poll();
		this.interval = setInterval(() => this.poll(), intervalMs);
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private async poll(): Promise<void> {
		const data: StatusData = {
			syncStatus: await this.readText('.sync-status'),
			syncWarnings: await this.readText('.sync-warnings'),
			lastSyncEpoch: await this.readEpoch('toolkit-state/.sync-marker'),
			syncInProgress: await this.dirExists('toolkit-state/.sync-lock'),
			backupMeta: await this.readJson('backup-meta.json'),
			usage: await this.readJson('.usage-cache.json'),
			announcement: await this.readJson('.announcement-cache.json'),
			updateStatus: await this.readJson('toolkit-state/update-status.json'),
		};
		this.emit('status', data);
	}

	private async readText(relativePath: string): Promise<string> {
		try {
			return await fs.promises.readFile(path.join(this.claudeDir, relativePath), 'utf8');
		} catch {
			return '';
		}
	}

	private async readJson(relativePath: string): Promise<any> {
		const text = await this.readText(relativePath);
		if (!text) return null;
		try { return JSON.parse(text); } catch { return null; }
	}

	private async readEpoch(relativePath: string): Promise<number | null> {
		const text = await this.readText(relativePath);
		if (!text) return null;
		const num = parseInt(text, 10);
		return isNaN(num) ? null : num;
	}

	private async dirExists(relativePath: string): Promise<boolean> {
		try {
			const stat = await fs.promises.stat(path.join(this.claudeDir, relativePath));
			return stat.isDirectory();
		} catch {
			return false;
		}
	}
}
