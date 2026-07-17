/**
 * Sanitize a YouTube video title into a safe, readable filename.
 * - removes emoji/special chars, keeps letters (incl. accents), digits, spaces, - _ .
 * - collapses whitespace, trims, truncates to maxLen without cutting mid-word if possible
 */
export function sanitizeFilename(title: string, maxLen = 60): string {
  let s = title
    .normalize('NFKC')
    // strip anything that's not letter/number/space/dash/underscore/dot
    .replace(/[^\p{L}\p{N} \-_.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    // avoid trailing dots (Windows/SMB unfriendly)
    .replace(/\.+$/, '');

  if (s.length === 0) return 'audio';

  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return s;
}
