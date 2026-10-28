import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectType, stripMetadata } from '../netlify/functions/lib/exif.mjs';

function seg(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

test('detects JPEG and PNG by magic bytes, rejects others', () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(detectType(jpg), 'image/jpeg');
  assert.equal(detectType(png), 'image/png');
  assert.equal(detectType(Buffer.from('GIF89a....')), null);
});

test('JPEG: EXIF with GPS is removed, scan data and colour profile survive', () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0')),                      // APP0 keep
    seg(0xe1, Buffer.from('Exif\0\0GPS-SECRET-LOCATION')), // APP1 drop
    seg(0xe2, Buffer.from('ICC_PROFILE\0')),               // APP2 keep (colour)
    seg(0xdb, Buffer.from([0, 1, 2, 3])),
    seg(0xda, Buffer.from([0, 1, 0, 0, 0, 0])),
    Buffer.from('SCAN-DATA'),
    Buffer.from([0xff, 0xd9]),
  ]);
  const out = stripMetadata(jpeg, 'image/jpeg');
  assert.equal(out.includes('GPS-SECRET'), false);
  assert.equal(out.includes('JFIF'), true);
  assert.equal(out.includes('ICC_PROFILE'), true);
  assert.equal(out.includes('SCAN-DATA'), true);
  assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...out.subarray(out.length - 2)], [0xff, 0xd9]);
});

test('JPEG: truncated segment is rejected', () => {
  const bad = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0x00, 0x50, 0x01])]);
  assert.throws(() => stripMetadata(bad, 'image/jpeg'), /Malformed JPEG/);
});

test('PNG: text and EXIF chunks are removed, image chunks survive', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.from('GPS-SECRET-LOCATION')),
    chunk('eXIf', Buffer.from('EXIF-SECRET')),
    chunk('IDAT', Buffer.from('PIXELS')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const out = stripMetadata(png, 'image/png');
  assert.equal(out.includes('GPS-SECRET'), false);
  assert.equal(out.includes('EXIF-SECRET'), false);
  assert.equal(out.includes('PIXELS'), true);
  assert.equal(out.includes('IEND'), true);
});
