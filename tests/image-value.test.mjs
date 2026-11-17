import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDirectImageUrl, safeSignedImageUrl } from '../lib/imageValue.ts';

test('image values reject active content, credentials, insecure transport and malformed URLs', () => {
  for (const value of [
    'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=', 'file:///etc/passwd',
    '//tracking.example/a.png', 'http://images.example/a.png',
    'https://user:password@images.example/a.png', ' https://images.example/a.png',
    'https://images.example/\nscript', 'https://', '', null
  ]) assert.equal(safeDirectImageUrl(value), null);
});
test('image values retain supported raster base64 and HTTPS images', () => {
  for (const value of [
    'https://images.example/a.png?x=1', 'data:image/png;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,/9j/4AAQ', 'data:image/gif;base64,R0lGODlhAQABAAD=',
    'data:image/webp;base64,UklGRg=='
  ]) assert.equal(safeDirectImageUrl(value), value);
});
test('signed image URLs must match the configured service and requested key', () => {
  const key = 'clinics/test/patients/test/key.jpg';
  const url = `https://images.example/file?key=${encodeURIComponent(key)}&exp=123&sig=signature`;
  assert.equal(safeSignedImageUrl(url, 'https://images.example', key), url);
  for (const value of [
    url.replace('images.example', 'foreign.example'), url.replace('/file?', '/upload?'),
    url.replace('key.jpg', 'other.jpg'), 'javascript:alert(1)', undefined
  ]) assert.equal(safeSignedImageUrl(value, 'https://images.example', key), null);
});
