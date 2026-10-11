// Packages the local scanner bridge into the ZIP the website hands out.
//
// Why this exists: the desktop bridge is a Python service that reads real OS WiFi and
// Bluetooth adapters, so it cannot run inside a browser tab. Rather than telling an operator
// to clone a repository and find a folder, the site serves the exact folder as one download
// from its own origin, and lists what is inside so the download can be checked before it is
// run.
//
// The archive is written to dist/api/ because that directory is already shipped with the
// serverless function (`includeFiles: dist/**` in vercel.json), so no extra deployment
// configuration is needed to keep it available in production.
//
// Entries use the standard ZIP container with raw deflate. Timestamps are pinned to a fixed
// DOS epoch so two builds of the same sources produce identical bytes.
//
//   node scripts/build-scanner-zip.mjs
//
// Writes: dist/api/scanner-bridge.zip
//         dist/api/scanner-bridge.json

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, 'scanner');
const outputDir = path.join(repoRoot, 'dist', 'api');
/** Every entry sits under this folder, so extracting produces one self-contained directory. */
const archiveRoot = 'backspyne-scanner';

/** Never shipped: local secrets, caches, and installed dependencies. */
const SKIP_DIRECTORIES = new Set(['__pycache__', '.venv', 'venv', 'node_modules', '.git', '.mypy_cache', '.pytest_cache']);
const SKIP_FILES = new Set(['.env', '.env.local', '.DS_Store']);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function collect(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collect(path.join(directory, entry.name), relative));
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    files.push({ relative: relative.split(path.sep).join('/'), absolute: path.join(directory, entry.name) });
  }
  return files;
}

/**
 * Builds one ZIP archive. Only what a ZIP reader needs is written: local file headers, the
 * compressed payloads, the central directory, and the end-of-central-directory record.
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // Storing a payload that deflate made larger is allowed and keeps the file exact.
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x0021, 10); // fixed DOS date: 1980-01-01
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x0021, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function buildScannerArchive() {
  const files = (await collect(sourceDir)).sort((left, right) => left.relative.localeCompare(right.relative));
  if (!files.length) throw new Error(`No files found to package in ${sourceDir}`);
  const entries = [];
  const manifestFiles = [];
  for (const file of files) {
    const data = await readFile(file.absolute);
    const name = `${archiveRoot}/${file.relative}`;
    entries.push({ name, data });
    manifestFiles.push({ path: name, bytes: data.length });
  }
  return { zip: buildZip(entries), files: manifestFiles };
}

async function main() {
  const { zip, files } = await buildScannerArchive();
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'scanner-bridge.zip'), zip);
  await writeFile(
    path.join(outputDir, 'scanner-bridge.json'),
    `${JSON.stringify({
      fileName: 'backspyne-scanner.zip',
      archiveRoot,
      builtAt: new Date().toISOString(),
      bytes: zip.length,
      fileCount: files.length,
      files,
    }, null, 2)}\n`,
  );
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`scanner bundle: ${files.length} files, ${total} bytes of source, ${zip.length} bytes zipped -> dist/api/scanner-bridge.zip`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
