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

  it('falls back when title is only special chars', () => {
    expect(sanitizeFilename('★☆★☆')).toBe('audio');
  });

  it('strips trailing dots', () => {
    expect(sanitizeFilename('Ending...')).toBe('Ending');
  });
});
