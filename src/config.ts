// All runtime configuration lives here so the conversion pipeline, the job
// registry and the routes read the same values.

export const PORT = Number(process.env.PORT ?? 3000);
export const AUTH_TOKEN = process.env.AUTH_TOKEN ?? '';
export const YTDLP = process.env.YTDLP_PATH ?? 'yt-dlp';
export const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 15 * 60 * 1000);

// Serialize conversions: the DS220+ has limited CPU, so concurrent ffmpeg runs
// crawl. One heavy job runs at a time; extra requests wait, up to MAX_QUEUE.
export const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 4);

// Optional cookies.txt for when YouTube starts bot-blocking this IP. Unset by
// default; yt-dlp is only given --cookies when a path is configured.
export const COOKIES_FILE = process.env.COOKIES_FILE ?? '';

// Optional NAS share to drop a second copy of each mp3 into. Unset means the
// mp3 is only streamed back to the caller.
export const SAVE_DIR = process.env.SAVE_DIR ?? '';

// How long a finished async job (and its mp3 on disk) is kept before the
// sweeper deletes it. Long enough for the Shortcut to poll and download.
export const JOB_TTL_MS = Number(process.env.JOB_TTL_MS ?? 30 * 60 * 1000);

// The container runs as root, so anything it writes into SAVE_DIR is root-owned
// and a nuisance to manage from DSM or over SMB. These name the NAS account that
// should own the saved copies. Either may be set alone; unset leaves ownership
// as-is, which is the right default for anyone not running this on a NAS.
export const SAVE_UID = optionalId('SAVE_UID');
export const SAVE_GID = optionalId('SAVE_GID');

// Mode applied to SAVE_DIR itself. The default is world-readable on purpose:
// the point of the share is that something else (a media server, another user)
// can walk it, and the umask we inherit would otherwise leave it at 0700.
export const SAVE_DIR_MODE = parseMode(process.env.SAVE_DIR_MODE) ?? 0o755;

/** Parse an optional uid/gid, failing loudly at startup rather than silently
 *  ignoring a typo that would leave files owned by root. */
function optionalId(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Parse an optional octal directory mode ("755", "0775"). Same loud-failure
 *  rule as the uid/gid parsing: a typo here silently hides the share. */
function parseMode(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw.trim(), 8);
  if (!/^0?[0-7]{3,4}$/.test(raw.trim()) || !Number.isInteger(value)) {
    throw new Error(`SAVE_DIR_MODE must be an octal mode like 755, got ${JSON.stringify(raw)}`);
  }
  return value;
}
