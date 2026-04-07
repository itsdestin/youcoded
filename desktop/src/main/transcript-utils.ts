import fs from 'fs';

export interface TranscriptMeta {
	model: string;
	contextPercent: number | null;
}

/**
 * Reads transcript metadata efficiently:
 * - Model name from first 4KB (always in early handshake lines)
 * - Context percentage by scanning backward from EOF in 64KB chunks
 *   (JSONL lines can be 10-100KB+, so 4KB from EOF would land mid-line)
 */
export async function readTranscriptMeta(transcriptPath: string): Promise<TranscriptMeta> {
	let model = '';
	let contextPercent: number | null = null;

	const handle = await fs.promises.open(transcriptPath, 'r');
	try {
		const stat = await handle.stat();
		const fileSize = stat.size;
		if (fileSize === 0) return { model, contextPercent };

		// --- Model name: first 4KB ---
		const headSize = Math.min(4096, fileSize);
		const headBuf = Buffer.alloc(headSize);
		await handle.read(headBuf, 0, headSize, 0);
		const headText = headBuf.toString('utf8');
		for (const line of headText.split('\n')) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				if (obj.model) {
					model = obj.model.display_name || obj.model.id || obj.model;
					break;
				}
			} catch {}
		}

		// --- Context percent: scan backward in 64KB chunks ---
		const CHUNK = 65536;
		let pos = Math.max(0, fileSize - CHUNK);
		outer: while (true) {
			const readSize = Math.min(CHUNK, fileSize - pos);
			if (readSize <= 0) break;
			const buf = Buffer.alloc(readSize);
			await handle.read(buf, 0, readSize, pos);
			const text = buf.toString('utf8');
			const lines = text.split('\n').reverse();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line);
					if (obj.costInfo?.contextPercent != null) {
						contextPercent = obj.costInfo.contextPercent;
						break outer;
					}
					if (obj.context_window?.remaining_percentage != null) {
						contextPercent = obj.context_window.remaining_percentage;
						break outer;
					}
				} catch {}
			}
			if (pos === 0) break;
			pos = Math.max(0, pos - CHUNK);
		}
	} finally {
		await handle.close();
	}

	return { model, contextPercent };
}
