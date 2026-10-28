// Strips location and camera metadata from JPEG and PNG files without any dependencies.
//
// JPEG: drops APP1 (EXIF/XMP), APP3-APP15 (Photoshop/IPTC and other app data), and COM comments.
//       Keeps APP0 (JFIF) and APP2 (ICC colour profile) so phone photos don't shift colour.
// PNG:  drops tEXt, zTXt, iTXt, eXIf, and tIME chunks.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DROP_PNG = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function detectType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  return null;
}

export function stripMetadata(buf, type) {
  if (type === 'image/png') return stripPng(buf);
  if (type === 'image/jpeg') return stripJpeg(buf);
  throw new Error(`Unsupported type: ${type}`);
}

function dropJpegSegment(marker) {
  return marker === 0xe1 || (marker >= 0xe3 && marker <= 0xef) || marker === 0xfe;
}

function stripJpeg(buf) {
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('Malformed JPEG');
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }            // fill byte
    if (marker === 0xd9) { parts.push(buf.subarray(i, i + 2)); break; } // end of image
    if (marker === 0xda) { parts.push(buf.subarray(i)); break; }        // scan data: copy the rest
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {        // markers without length
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) throw new Error('Malformed JPEG');
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (end > buf.length) throw new Error('Malformed JPEG');
    if (!dropJpegSegment(marker)) parts.push(buf.subarray(i, end));
    i = end;
  }
  return Buffer.concat(parts);
}

function stripPng(buf) {
  const parts = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('Malformed PNG');
    if (!DROP_PNG.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}
