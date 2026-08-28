import { describe, it, expect } from 'vitest';
import { describeFailure } from '../src/convert.js';

/** Shape of what promisified execFile rejects with. */
function execError(message: string, stderr = '', killed = false) {
  return Object.assign(new Error(message), { stderr, killed });
}

describe('describeFailure', () => {
  it('reports a timeout in plain language', () => {
    const err = execError('Command failed: yt-dlp ...', '', true);
    expect(describeFailure(err)).toContain('timed out after 900s');
  });

  it("prefers yt-dlp's error line over execFile's noisy message", () => {
    // The execFile message is the entire command line, which would otherwise
    // eat the whole 100-char budget before reaching the real reason.
    const err = execError(
      'Command failed: /usr/local/bin/yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 0 -o /tmp/yt2mp3-abcdef/audio.%(ext)s https://youtu.be/x',
      '[youtube] x: Downloading webpage\nERROR: Sign in to confirm you are not a bot\n',
    );
    const msg = describeFailure(err);
    expect(msg).toBe('conversion failed: Sign in to confirm you are not a bot');
    expect(msg).not.toContain('Command failed');
  });

  it('strips the ERROR: prefix', () => {
    const err = execError('boom', 'ERROR: Video unavailable\n');
    expect(describeFailure(err)).toBe('conversion failed: Video unavailable');
  });

  it('uses the last error line when yt-dlp emits several', () => {
    const err = execError('boom', 'ERROR: first problem\nERROR: fatal problem\n');
    expect(describeFailure(err)).toBe('conversion failed: fatal problem');
  });

  it('ignores non-error stderr chatter', () => {
    const err = execError('no mp3 produced', '[youtube] Downloading webpage\n[info] Writing\n');
    expect(describeFailure(err)).toBe('conversion failed: no mp3 produced');
  });

  it('falls back to the error message when stderr is empty', () => {
    expect(describeFailure(execError('no mp3 produced'))).toBe('conversion failed: no mp3 produced');
  });

  it('handles a non-Error being thrown', () => {
    expect(describeFailure('kaboom')).toBe('conversion failed: kaboom');
  });

  it('caps the message at 100 chars', () => {
    const err = execError('boom', `ERROR: ${'x'.repeat(500)}\n`);
    expect(describeFailure(err).length).toBe(100);
  });

  it('collapses newlines and runs of whitespace', () => {
    const err = execError('a\n\n  b   c');
    expect(describeFailure(err)).toBe('conversion failed: a b c');
  });
});
