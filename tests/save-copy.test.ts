import { describe, it, expect, vi } from 'vitest';
import { uniqueName, applyOwnership, prepareShareDir } from '../src/convert.js';

/** Build an `exists` probe backed by a fixed set of paths. */
const existing = (...paths: string[]) => async (p: string) => paths.includes(p);

const silentLog = () => ({ info: vi.fn(), warn: vi.fn() });

describe('uniqueName', () => {
  it('keeps the original name when nothing collides', async () => {
    expect(await uniqueName('/share', 'Song.mp3', existing())).toBe('Song.mp3');
  });

  it('suffixes the stem, not the extension, on a collision', async () => {
    const name = await uniqueName('/share', 'Song.mp3', existing('/share/Song.mp3'));
    expect(name).toBe('Song (2).mp3');
  });

  it('keeps counting past repeated collisions', async () => {
    const name = await uniqueName(
      '/share',
      'Song.mp3',
      existing('/share/Song.mp3', '/share/Song (2).mp3', '/share/Song (3).mp3'),
    );
    expect(name).toBe('Song (4).mp3');
  });

  it('handles a name with dots in the stem', async () => {
    const name = await uniqueName('/share', 'S.M.B. Theme.mp3', existing('/share/S.M.B. Theme.mp3'));
    expect(name).toBe('S.M.B. Theme (2).mp3');
  });

  it('handles a name with no extension', async () => {
    expect(await uniqueName('/share', 'Song', existing('/share/Song'))).toBe('Song (2)');
  });

  it('falls back to a timestamped name rather than looping forever', async () => {
    // Everything collides: must still terminate with a usable, unique name.
    const name = await uniqueName('/share', 'Song.mp3', async () => true, 5);
    expect(name).toMatch(/^Song-\d+\.mp3$/);
  });
});

describe('applyOwnership', () => {
  it('does nothing when neither uid nor gid is configured', async () => {
    const chownFn = vi.fn();
    const log = silentLog();
    expect(await applyOwnership('/share/Song.mp3', log, { chownFn })).toBe(false);
    expect(chownFn).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('chowns to the configured uid and gid', async () => {
    const chownFn = vi.fn(async () => {});
    expect(
      await applyOwnership('/share/Song.mp3', silentLog(), { uid: 1028, gid: 100, chownFn }),
    ).toBe(true);
    expect(chownFn).toHaveBeenCalledWith('/share/Song.mp3', 1028, 100);
  });

  it('passes -1 for the half that is not configured, leaving it unchanged', async () => {
    const chownFn = vi.fn(async () => {});
    await applyOwnership('/share/Song.mp3', silentLog(), { uid: 1028, chownFn });
    expect(chownFn).toHaveBeenCalledWith('/share/Song.mp3', 1028, -1);

    chownFn.mockClear();
    await applyOwnership('/share/Song.mp3', silentLog(), { gid: 100, chownFn });
    expect(chownFn).toHaveBeenCalledWith('/share/Song.mp3', -1, 100);
  });

  it('treats uid 0 as configured rather than absent', async () => {
    const chownFn = vi.fn(async () => {});
    expect(await applyOwnership('/share/Song.mp3', silentLog(), { uid: 0, chownFn })).toBe(true);
    expect(chownFn).toHaveBeenCalledWith('/share/Song.mp3', 0, -1);
  });

  it('logs and keeps the file when chown fails', async () => {
    // A share mounted without the right privileges must not cost us the copy.
    const chownFn = vi.fn(async () => {
      throw new Error('EPERM: operation not permitted');
    });
    const log = silentLog();
    expect(
      await applyOwnership('/share/Song.mp3', log, { uid: 1028, gid: 100, chownFn }),
    ).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('prepareShareDir', () => {
  const stubs = () => ({
    mkdirFn: vi.fn(async () => undefined),
    chmodFn: vi.fn(async () => {}),
  });

  it('creates the directory with the mode and sets it again afterwards', async () => {
    // mkdir's mode is masked by the umask -- the explicit chmod is what
    // actually leaves the share readable by a media server.
    const { mkdirFn, chmodFn } = stubs();
    await prepareShareDir('/share', silentLog(), { mode: 0o755, mkdirFn, chmodFn });
    expect(mkdirFn).toHaveBeenCalledWith('/share', { recursive: true, mode: 0o755 });
    expect(chmodFn).toHaveBeenCalledWith('/share', 0o755);
  });

  it('propagates a mkdir failure: there is nowhere to copy to', async () => {
    const { chmodFn } = stubs();
    const mkdirFn = vi.fn(async () => {
      throw new Error('EROFS: read-only file system');
    });
    await expect(
      prepareShareDir('/share', silentLog(), { mkdirFn, chmodFn }),
    ).rejects.toThrow('EROFS');
    expect(chmodFn).not.toHaveBeenCalled();
  });

  it('logs and carries on when the mode cannot be set', async () => {
    // A share someone else created is still perfectly usable.
    const { mkdirFn } = stubs();
    const chmodFn = vi.fn(async () => {
      throw new Error('EPERM: operation not permitted');
    });
    const log = silentLog();
    await expect(
      prepareShareDir('/share', log, { mkdirFn, chmodFn }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
