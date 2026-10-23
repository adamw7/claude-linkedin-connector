import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, isInside } from '../src/paths.js';

describe('expandHome', () => {
  it('replaces a leading ~ with the home directory', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/Downloads')).toBe(`${homedir()}/Downloads`);
    expect(expandHome('~\\Downloads')).toBe(`${homedir()}\\Downloads`);
  });

  it('leaves other paths alone', () => {
    expect(expandHome('~user/Downloads')).toBe('~user/Downloads');
    expect(expandHome('/tmp/~/x')).toBe('/tmp/~/x');
    expect(expandHome('photo.jpg')).toBe('photo.jpg');
  });
});

describe('isInside', () => {
  const dir = join(homedir(), 'Downloads');

  it('accepts the folder itself and anything below it', () => {
    expect(isInside(dir, dir)).toBe(true);
    expect(isInside(dir, join(dir, 'photo.jpg'))).toBe(true);
    expect(isInside(dir, join(dir, 'a', 'b', 'photo.jpg'))).toBe(true);
    expect(isInside(dir, join(dir, '..photo.jpg'))).toBe(true);
  });

  it('refuses the parent, siblings and paths that only share a prefix', () => {
    expect(isInside(dir, homedir())).toBe(false);
    expect(isInside(dir, join(homedir(), 'Desktop', 'photo.jpg'))).toBe(false);
    expect(isInside(dir, `${dir}-old`)).toBe(false);
    expect(isInside(dir, join(dir, '..', 'Desktop'))).toBe(false);
  });
});
