import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SaxesParser } from 'saxes';
import { fail } from './store.js';

export const fileExtensions = ['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.svg', '.dxf'];
export function validateFilename(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 240 || /[\x00-\x1f\x7f/\\:]/u.test(name)) {
    fail('Use a filename under 240 bytes without slashes or control characters.');
  }
  const extension = path.extname(name).toLowerCase();
  if (!fileExtensions.includes(extension)) fail('Attach a PDF, JPG, PNG, or TIFF file for printing, or an SVG or DXF file for foam cutting.');
  return extension;
}

// Static SVG only. Reject active content instead of modifying the user's design.
// No DTD, scripting, CSS, foreign content, remote resources or XML instructions.
function svgChecker() {
  const parser = new SaxesParser({ xmlns: true });
  const tags = new Set('svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath'.split(' '));
  const attributes = new Set('id version x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule font-family font-size font-weight font-style text-anchor dominant-baseline dx dy rotate offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr'.split(' '));
  let depth = 0, root = false, tokenLength = 0, inTag = false, quote = '';
  parser.on('doctype', () => fail('SVG document types and entities are not supported.'));
  parser.on('processinginstruction', () => fail('SVG processing instructions are not supported.'));
  parser.on('cdata', () => fail('SVG CDATA is not supported.'));
  parser.on('error', () => fail('The SVG is not well-formed XML.'));
  parser.on('opentag', tag => {
    if (++depth > 100) fail('SVG nesting is too complex. Export a flattened PDF instead.');
    if (!root && tag.local !== 'svg') fail('The SVG must have an svg root element.');
    root = true;
    if (tag.uri !== 'http://www.w3.org/2000/svg' || !tags.has(tag.local)) fail('SVG contains unsupported or active elements. Export a flattened PDF instead.');
    for (const attr of Object.values(tag.attributes)) {
      if (attr.name === 'xmlns' && attr.value === 'http://www.w3.org/2000/svg') continue;
      if (attr.name === 'xml:space' && ['default', 'preserve'].includes(attr.value)) continue;
      if (attr.prefix || !attributes.has(attr.local)) fail('SVG contains unsupported attributes. Remove scripts, styles and external resources.');
      if (/\\|\/\*|(?:https?|data|javascript):/i.test(attr.value)) fail('SVG escaped styles and external resources are not allowed.');
      if (/url\s*\(/i.test(attr.value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(attr.value)) fail('SVG external resources are not allowed.');
    }
  });
  parser.on('closetag', () => { depth--; });
  return {
    write(chunk) {
      // Bound any individual parser token, not the total file size. Check before parsing.
      for (const char of chunk) {
        if (++tokenLength > 262144) fail('An SVG element is too complex. Export a flattened PDF instead.');
        if (inTag) {
          if (quote) { if (char === quote) quote = ''; }
          else if (char === '"' || char === "'") quote = char;
          else if (char === '>') { inTag = false; tokenLength = 0; }
        } else if (char === '<') { inTag = true; tokenLength = 0; }
      }
      parser.write(chunk);
    },
    end() { parser.close(); if (!root) fail('The SVG is empty.'); },
  };
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
  const checker = extension === '.svg' ? svgChecker() : extension === '.dxf' ? dxfChecker() : null;
  const decoder = checker ? new TextDecoder('utf-8', { fatal: true }) : null;
  const hash = crypto.createHash('sha256');
  let first = Buffer.alloc(0), last = Buffer.alloc(0), size = 0;
  try {
    for await (const chunk of createReadStream(file.path)) {
      hash.update(chunk); size += chunk.length;
      if (first.length < 16) first = Buffer.concat([first, chunk]).subarray(0, 16);
      last = Buffer.concat([last, chunk]).subarray(-2048);
      if (checker) checker.write(decoder.decode(chunk, { stream: true }));
    }
    if (checker) { checker.write(decoder.decode()); checker.end(); }
  } catch (error) {
    if (error instanceof TypeError) fail('SVG and ASCII DXF files must use valid UTF-8 text.');
    throw error;
  }
  if (!size) fail('Empty files cannot be submitted.');
  const hex = first.toString('hex');
  const valid = checker || (extension === '.pdf' && /^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(first.toString('ascii')) && /%%EOF\s*$/.test(last.toString('latin1')))
    || (extension === '.png' && hex.startsWith('89504e470d0a1a0a') && last.subarray(-12).toString('hex') === '0000000049454e44ae426082')
    || (['.jpg', '.jpeg'].includes(extension) && hex.startsWith('ffd8ff') && last.subarray(-2).toString('hex') === 'ffd9')
    || (['.tif', '.tiff'].includes(extension) && /^(49492a00|4d4d002a|49492b00|4d4d002b)/.test(hex));
  if (!valid) fail('The file content does not match its extension, or the file is incomplete.');
  if (scanner) await scanner(file.path);
  return { originalName: file.originalname, storedName: file.filename, size, sha256: hash.digest('hex'),
    validation: 'screened-v1', scan: scanner ? 'clean' : 'not-configured' };
}
