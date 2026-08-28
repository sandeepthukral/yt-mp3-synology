import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, copyFile, mkdir, access, chown, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeFilename } from './sanitize.js';
import {
  YTDLP,
  DOWNLOAD_TIMEOUT_MS,
  COOKIES_FILE,
  SAVE_DIR,
  SAVE_UID,
  SAVE_GID,
  SAVE_DIR_MODE,
} from './config.js';

const execFileP = promisify(execFile);

export interface Conversion {
  /** Temp dir holding the mp3; the caller owns deleting it. */
  dir: string;
  /** Absolute path to the produced mp3. */
  path: string;
  /** Sanitized "<title>.mp3" to serve as the download filename. */
  filename: string;
}

/** Logger shape shared by Fastify's request and app loggers. */
interface Log {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/** yt-dlp reads cookies only when one is configured, so this is a no-op by default. */
function cookieArgs(): string[] {
  return COOKIES_FILE ? ['--cookies', COOKIES_FILE] : [];
}

/** Raised when yt-dlp can't read the video's metadata; the caller maps this to a 502. */
export class MetadataError extends Error {}

/** Fetch just the title — fast, no download — so the filename is known up front. */
export async function fetchTitle(url: string): Promise<string> {
  try {
    const { stdout } = await execFileP(
      YTDLP,
      [...cookieArgs(), '--no-playlist', '--print', 'title', '--skip-download', url],
      { timeout: 60_000 },
    );
    return stdout.trim().split('\n')[0] ?? 'audio';
  } catch (err) {
    throw new MetadataError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Download the video and extract an mp3 into a fresh temp dir.
 * Throws on failure; the temp dir is cleaned up before the throw.
 */
export async function convertToMp3(url: string, title: string): Promise<Conversion> {
  const safeName = sanitizeFilename(title);
  const dir = await mkdtemp(join(tmpdir(), 'yt2mp3-'));

  await execFileP(
    YTDLP,
    [
      ...cookieArgs(),
      '--no-playlist',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      // Embed real ID3 tags (title, etc.) rather than shipping a bare mp3...
      '--embed-metadata',
      // ...and map the channel onto the Artist field, so VLC groups by channel.
      '--parse-metadata', '%(uploader)s:%(meta_artist)s',
      '-o', join(dir, 'audio.%(ext)s'),
      url,
    ],
    { timeout: DOWNLOAD_TIMEOUT_MS },
  );

  const files = await readdir(dir);
  const mp3 = files.find((f) => f.endsWith('.mp3'));
  if (!mp3) throw new Error('no mp3 produced');

  return { dir, path: join(dir, mp3), filename: `${safeName}.mp3` };
}

/**
 * Pick a name that doesn't clobber an existing file, appending " (2)", " (3)"...
 * Exported for tests. `exists` is injectable so tests don't touch the filesystem.
 */
export async function uniqueName(
  dir: string,
  filename: string,
  exists: (p: string) => Promise<boolean>,
  maxTries = 100,
): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';

  for (let n = 1; n <= maxTries; n++) {
    const candidate = n === 1 ? filename : `${stem} (${n})${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  // Give up on pretty names rather than looping forever or overwriting.
  return `${stem}-${Date.now()}${ext}`;
}

const fileExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Drop a second copy of the mp3 into SAVE_DIR, if configured.
 * Never throws: a full or unmounted share must not fail an otherwise good
 * conversion, so problems are logged and swallowed.
 */
export async function maybeSaveCopy(
  source: string,
  filename: string,
  log: Log,
): Promise<string | undefined> {
  if (!SAVE_DIR) return undefined;
  try {
    await prepareShareDir(SAVE_DIR, log);
    const name = await uniqueName(SAVE_DIR, filename, fileExists);
    const dest = join(SAVE_DIR, name);
    await copyFile(source, dest);
    await applyOwnership(dest, log);
    log.info({ dest }, 'saved copy to share');
    return dest;
  } catch (err) {
    log.warn({ err, dir: SAVE_DIR }, 'could not save copy to share');
    return undefined;
  }
}

/**
 * Make sure the share directory exists and that other users can actually read
 * it. Node's mkdir mode is masked by the container's umask, which left the
 * directory at 0700 and invisible to anything but root -- a media server
 * scanning the share could not even enter it. So the mode is set explicitly
 * afterwards, and the directory is handed to the same owner as the files in it.
 *
 * mkdir failures propagate: without the directory there is nowhere to copy to.
 * chmod failures are logged and swallowed -- a share created by someone else is
 * still perfectly usable, and losing the copy over it would be worse.
 *
 * mkdirFn/chmodFn/mode are injectable for tests; production passes none of them.
 */
export async function prepareShareDir(
  dir: string,
  log: Log,
  {
    mode = SAVE_DIR_MODE,
    mkdirFn = mkdir,
    chmodFn = chmod,
  }: {
    mode?: number;
    mkdirFn?: (path: string, opts: { recursive: true; mode: number }) => Promise<unknown>;
    chmodFn?: (path: string, mode: number) => Promise<void>;
  } = {},
): Promise<void> {
  await mkdirFn(dir, { recursive: true, mode });
  try {
    await chmodFn(dir, mode);
  } catch (err) {
    log.warn({ err, dir, mode }, 'could not set mode on share directory');
  }
  await applyOwnership(dir, log);
}

/**
 * Hand a saved copy to the configured owner. Without this every file in the
 * share belongs to root, since that's who the container runs as.
 *
 * A failure here is logged and swallowed on purpose: the mp3 is already written
 * and readable, and wrong ownership is a far smaller problem than losing the
 * copy. -1 means "leave this half unchanged", so a uid can be set without a gid.
 *
 * uid/gid/chownFn are injectable for tests; production passes none of them.
 */
export async function applyOwnership(
  dest: string,
  log: Log,
  {
    uid = SAVE_UID,
    gid = SAVE_GID,
    chownFn = chown,
  }: {
    uid?: number;
    gid?: number;
    chownFn?: (path: string, uid: number, gid: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  if (uid === undefined && gid === undefined) return false;
  try {
    await chownFn(dest, uid ?? -1, gid ?? -1);
    return true;
  } catch (err) {
    log.warn({ err, dest, uid, gid }, 'could not set owner on saved copy');
    return false;
  }
}

/** Turn a conversion failure into a short, caller-friendly reason. */
export function describeFailure(err: unknown): string {
  // Surface the underlying reason (e.g. timeout on long videos); capped at 100 chars.
  const e = err as { killed?: boolean; stderr?: unknown } | null;
  if (e && typeof e === 'object' && e.killed) {
    return `conversion failed: timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s (video too long?)`;
  }

  // Prefer yt-dlp's own last error line. execFile's message is
  // "Command failed: <the whole command>", which is long enough that the cap
  // below would swallow the actual reason.
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
  const ytdlpError = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^(ERROR|WARNING: .*error)/i.test(l))
    .pop();

  const detail = (ytdlpError ?? (err instanceof Error ? err.message : String(err)))
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `conversion failed: ${detail}`.slice(0, 100);
}
