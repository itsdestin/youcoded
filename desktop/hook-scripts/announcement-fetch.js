// core/hooks/announcement-fetch.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ANNOUNCEMENTS_URL =
  'https://raw.githubusercontent.com/itsdestin/destinclaude/master/announcements.txt';

const home = os.homedir();
const cachePath = path.join(home, '.claude', '.announcement-cache.json');
const tmpPath = cachePath + '.tmp';

async function run() {
  let response;
  try {
    response = await fetch(ANNOUNCEMENTS_URL);
  } catch (_) {
    return; // offline or DNS failure — leave existing cache intact
  }

  if (!response.ok) return; // non-200 — treat as offline

  const text = await response.text();
  const lines = text.split('\n');

  let message = '';
  let expires;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Validate zero-padded date prefix: YYYY-MM-DD: message
    const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}): (.+)$/);
    if (dateMatch) {
      expires = dateMatch[1];
      message = dateMatch[2].trim();
    } else {
      message = trimmed;
    }
    break; // use only the first valid line
  }

  const cache = { message, fetched_at: new Date().toISOString() };
  if (expires) cache.expires = expires;

  // Atomic write: tmp → rename
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmpPath, cachePath);
  } catch (_) {
    try { fs.unlinkSync(tmpPath); } catch (_) {} // clean up tmp; ignore errors
  }
}

run().catch(() => {});
