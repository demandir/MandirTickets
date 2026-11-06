import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fail } from './store.js';

export const fileExtensions = [
  '.pdf', '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.gif', '.webp',
  '.bmp', '.dib', '.tif', '.tiff', '.svg', '.avif', '.heic', '.heif', '.hif',
  '.ico', '.jxl', '.dxf',
];
export function validateFilename(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 240 || /[\x00-\x1f\x7f/\\:]/u.test(name)) {
    fail('Use a filename under 240 bytes without slashes or control characters.');
  }
  const extension = path.extname(name).toLowerCase();
  if (!fileExtensions.includes(extension)) fail('Attach a PDF or common image file for printing, or an SVG or DXF file for foam cutting.');
  return extension;
}

function isIsoBmff(first, allowedBrands, size) {
  if (first.length < 16 || first.toString('ascii', 4, 8) !== 'ftyp') return false;
  const boxSize = first.readUInt32BE(0);
  if (boxSize < 16 || boxSize > size) return false;
  const brands = [first.toString('ascii', 8, 12)];
  for (let offset = 16; offset + 4 <= Math.min(boxSize, first.length); offset += 4) {
    brands.push(first.toString('ascii', offset, offset + 4));
  }
  return brands.some(brand => allowedBrands.includes(brand));
}

function isImageEnvelope(extension, first, last, size) {
  const hex = first.toString('hex');
  if (['.jpg', '.jpeg', '.jpe', '.jfif'].includes(extension)) {
    return hex.startsWith('ffd8ff') && last.subarray(-2).toString('hex') === 'ffd9';
  }
  if (['.png', '.apng'].includes(extension)) {
    return hex.startsWith('89504e470d0a1a0a') && last.subarray(-12).toString('hex') === '0000000049454e44ae426082';
  }
  if (extension === '.gif') {
    return size >= 14 && ['GIF87a', 'GIF89a'].includes(first.toString('ascii', 0, 6)) && last.at(-1) === 0x3b;
  }
  if (extension === '.webp') {
    return size >= 20 && first.toString('ascii', 0, 4) === 'RIFF' && first.toString('ascii', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(first.toString('ascii', 12, 16)) && first.readUInt32LE(4) === size - 8
      && first.readUInt32LE(16) <= size - 20;
  }
  if (extension === '.bmp') {
    return size >= 26 && first.toString('ascii', 0, 2) === 'BM' && first.readUInt32LE(2) === size
      && [12, 40, 52, 56, 64, 108, 124].includes(first.readUInt32LE(14));
  }
  if (extension === '.dib') {
    const headerSize = size >= 4 ? first.readUInt32LE(0) : 0;
    return [12, 40, 52, 56, 64, 108, 124].includes(headerSize) && size >= headerSize;
  }
  if (['.tif', '.tiff'].includes(extension)) return /^(49492a00|4d4d002a|49492b00|4d4d002b)/.test(hex);
  if (extension === '.avif') return isIsoBmff(first, ['avif', 'avis'], size);
  if (extension === '.heic') return isIsoBmff(first, ['heic', 'heix', 'hevc', 'hevx', 'heis', 'hevm'], size);
  if (['.heif', '.hif'].includes(extension)) {
    return isIsoBmff(first, ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx', 'heis', 'hevm'], size);
  }
  if (extension === '.ico') {
    const count = size >= 6 ? first.readUInt16LE(4) : 0;
    return size >= 6 + count * 16 && hex.startsWith('00000100') && count > 0;
  }
  if (extension === '.jxl') return (size > 2 && hex.startsWith('ff0a')) || hex.startsWith('0000000c4a584c200d0a870a');
  return false;
}

// Structural ASCII DXF screening only, not a CAD geometry/toolpath validator.
function dxfChecker() {
  let pending = '', code = null, section = false, sectionName = false, sawSection = false, eof = false;
  function line(value) {
    value = value.trim();
    if (eof) { if (value) fail('DXF has data after its EOF marker.'); return; }
    if (code === null) {
      if (!/^\d{1,4}$/.test(value) || Number(value) > 1071) fail('DXF contains an invalid group code.');
      code = Number(value); return;
    }
    const group = code; code = null;
    if (sectionName) {
      if (group !== 2 || !/^[A-Z0-9_]+$/.test(value)) fail('DXF section name is missing.');
      sectionName = false; return;
    }
    if (group === 0 && value === 'SECTION') {
      if (section) fail('DXF sections cannot be nested.');
      section = sectionName = sawSection = true;
    } else if (group === 0 && value === 'ENDSEC') {
      if (!section) fail('DXF has an unmatched ENDSEC.');
      section = false;
    } else if (group === 0 && value === 'EOF') {
      if (section || !sawSection) fail('DXF is incomplete.');
      eof = true;
    } else if (!section && group !== 999) fail('DXF data must be inside a section.');
    const numeric = (group >= 10 && group <= 79) || (group >= 110 && group <= 149) || (group >= 160 && group <= 179) || (group >= 210 && group <= 239) || (group >= 270 && group <= 299) || (group >= 370 && group <= 389) || (group >= 400 && group <= 409) || (group >= 420 && group <= 429) || (group >= 440 && group <= 459) || (group >= 460 && group <= 469) || (group >= 1010 && group <= 1071);
    if (numeric && (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) fail('DXF contains a non-finite or invalid numeric value.');
  }
  return {
    write(chunk) {
      if (/\x00/.test(chunk)) fail('Binary DXF is not supported. Export an ASCII DXF.');
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const item of lines) { if (item.length > 262144) fail('A DXF record is too long.'); line(item); }
      if (pending.length > 262144) fail('A DXF record is too long.');
    },
    end() { if (pending) line(pending); if (!eof || code !== null || sectionName) fail('DXF is truncated or missing EOF.'); },
  };
}

export function createMalwareScanner(executable) {
  if (!executable) return null;
  if (!path.isAbsolute(executable)) throw new Error('CLAMSCAN_PATH must be an absolute executable path.');
  return file => new Promise((resolve, reject) => {
    // Never invoke a shell; an incomplete/oversized/encrypted scan is not a clean result.
    const child = spawn(executable, ['--no-summary', '--alert-exceeds-max=yes', '--alert-encrypted=yes', '--', path.resolve(file)], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    timer.unref();
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('File scanner is unavailable. Try again later.'), { status: 503 })); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(code === 1 ? 'File failed the safety scan or could not be fully scanned.' : 'File scanner could not complete the scan. Try again later.'), { status: code === 1 ? 400 : 503 }));
    });
  });
}

export async function validateUpload(file, { scanner = null, requireScanner = false } = {}) {
  const extension = validateFilename(file.originalname);
  if (requireScanner && !scanner) fail('File scanning must be configured before accepting uploads.', 503);
  const checker = extension === '.dxf' ? dxfChecker() : null;
  const decoder = checker ? new TextDecoder('utf-8', { fatal: true }) : null;
  const hash = crypto.createHash('sha256');
  let first = Buffer.alloc(0), last = Buffer.alloc(0), size = 0;
  try {
    for await (const chunk of createReadStream(file.path)) {
      hash.update(chunk); size += chunk.length;
      if (first.length < 64) first = Buffer.concat([first, chunk]).subarray(0, 64);
      last = Buffer.concat([last, chunk]).subarray(-2048);
      if (checker) checker.write(decoder.decode(chunk, { stream: true }));
    }
    if (checker) { checker.write(decoder.decode()); checker.end(); }
  } catch (error) {
    if (error instanceof TypeError) fail('ASCII DXF files must use valid UTF-8 text.');
    throw error;
  }
  if (!size) fail('Empty files cannot be submitted.');
  const valid = extension === '.svg' || checker || (extension === '.pdf' && /^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(first.toString('ascii')) && /%%EOF\s*$/.test(last.toString('latin1')))
    || isImageEnvelope(extension, first, last, size);
  if (!valid) fail('The file content does not match its extension, or the file is incomplete.');
  if (scanner) await scanner(file.path);
  return { originalName: file.originalname, storedName: file.filename, size, sha256: hash.digest('hex'),
    validation: 'screened-v1', scan: scanner ? 'clean' : 'not-configured' };
}
