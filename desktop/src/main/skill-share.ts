/** Deep link encoding/decoding for skill sharing */

export function encodeSkillLink(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json).toString('base64url');
  const type = payload.type === 'plugin' ? 'plugin' : 'skill';
  return `destincode://${type}/${encoded}`;
}

export function decodeSkillLink(url: string): Record<string, unknown> | null {
  const match = url.match(/^destincode:\/\/(skill|plugin)\/(.+)$/);
  if (!match) return null;
  try {
    const json = Buffer.from(match[2], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
