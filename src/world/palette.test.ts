import { describe, expect, it } from 'vitest';
import { imageColor } from './palette';

describe('imageColor', () => {
  it('is stable per image and differs between images', () => {
    expect(imageColor('docker.io/library/nginx:latest')).toBe(imageColor('docker.io/library/nginx:latest'));
    expect(imageColor('docker.io/library/nginx:latest')).not.toBe(imageColor('docker.io/library/postgres:17'));
  });

  it('returns a 24-bit color', () => {
    const c = imageColor('quay.io/podman/hello');
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(0xffffff);
  });
});
