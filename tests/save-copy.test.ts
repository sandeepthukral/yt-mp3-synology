import { describe, it, expect } from 'vitest';
import { uniqueName } from '../src/convert.js';

/** Build an `exists` probe backed by a fixed set of paths. */
const existing = (...paths: string[]) => async (p: string) => paths.includes(p);

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
