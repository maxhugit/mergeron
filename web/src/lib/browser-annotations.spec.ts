import { expect, it } from 'vitest';
import { localAnnotationImage } from './browser-annotations';

it('decodes a bounded local raster as a File, never fetching a URL', async () => {
  const file = localAnnotationImage('data:image/jpeg;base64,/9j/AA==');
  expect(file).toBeInstanceOf(File);
  expect(file.name).toBe('browser-annotation.jpg');
  expect(file.type).toBe('image/jpeg');
  expect(file.size).toBe(4);
});
it.each([
  'https://example.org/image.jpg',
  'data:image/svg+xml;base64,PHN2Zy8+',
  'data:text/html;base64,PHNjcmlwdD4=',
  'data:image/jpeg;base64,SGVsbG8=',
  'data:image/jpeg;base64,' + 'A'.repeat(750_000),
])('rejects non-raster or excessive annotation data', (input) => {
  expect(() => localAnnotationImage(input)).toThrow();
});
