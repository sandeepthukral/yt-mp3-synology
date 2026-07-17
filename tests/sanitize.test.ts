import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../src/sanitize.js';

describe('sanitizeFilename', () => {
  it('removes emoji and special characters', () => {
    expect(sanitizeFilename('🔥 Best Song!! (Official Video) [4K] 🔥')).toBe(
      'Best Song Official Video 4K',
    );
  });

  it('keeps accented letters and digits', () => {
    expect(sanitizeFilename('Café del Mar – Vol. 2')).toBe('Café del Mar Vol. 2');
  });

  it('collapses whitespace', () => {
    expect(sanitizeFilename('  hello    world  ')).toBe('hello world');
  });

  it('truncates long titles at a word boundary', () => {
    const long = 'word '.repeat(30).trim();
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('word')).toBe(true);
  });

  it('falls back to a unique name when title is only special chars', () => {
    expect(sanitizeFilename('★☆★☆')).toMatch(/^audio-\d+$/);
  });

  it('strips trailing dots', () => {
    expect(sanitizeFilename('Ending...')).toBe('Ending');
  });

  it('strips leading dots so it is not a hidden dotfile', () => {
    expect(sanitizeFilename('.hidden file name')).toBe('hidden file name');
  });

  it('does not leave a trailing dot after truncation', () => {
    const out = sanitizeFilename('Hello world. Foo bar', 12);
    expect(out.endsWith('.')).toBe(false);
    expect(out).toBe('Hello world');
  });

  it('collapses a title that is only dots to the fallback', () => {
    expect(sanitizeFilename('...')).toMatch(/^audio-\d+$/);
  });

  it('keeps allowed dash/underscore/dot punctuation', () => {
    expect(sanitizeFilename('lo-fi_beats vol.2')).toBe('lo-fi_beats vol.2');
  });

  it('returns the fallback for an empty title', () => {
    expect(sanitizeFilename('')).toMatch(/^audio-\d+$/);
  });

  it('hard-cuts when there is no early word boundary', () => {
    const out = sanitizeFilename('a'.repeat(80), 60);
    expect(out).toBe('a'.repeat(60));
  });
});
