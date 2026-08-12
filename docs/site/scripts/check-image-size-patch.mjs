import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const vendorRoot = join(siteRoot, 'vendor', 'image-size');
const packageJson = JSON.parse(await readFile(join(vendorRoot, 'package.json'), 'utf8'));

if (packageJson.name !== 'image-size' || packageJson.version !== '2.0.3-devai.1') {
  throw new Error('Vendored image-size identity is not the reviewed patched build');
}

const bundleNames = (await readdir(join(vendorRoot, 'dist'))).filter((name) =>
  /^(detector|fromFile|index|lookup)\.(cjs|mjs)$/.test(name),
);
if (bundleNames.length !== 8) {
  throw new Error(`Expected 8 image-size bundles, found ${bundleNames.length}`);
}

const requiredFixes = [
  'ispeBox.offset + (ispeBox.size > 0 ? ispeBox.size : 8)',
  'jxlpBox.offset + (jxlpBox.size > 0 ? jxlpBox.size : 8)',
  'imageOffset += imageHeader[1] > 0 ? imageHeader[1] : 8',
];

for (const bundleName of bundleNames) {
  const bundle = await readFile(join(vendorRoot, 'dist', bundleName), 'utf8');
  for (const fix of requiredFixes) {
    if (!bundle.includes(fix)) {
      throw new Error(`${bundleName} is missing reviewed fix: ${fix}`);
    }
  }
}

console.log('PASS vendored image-size contains the reviewed ICNS/JXL/HEIF fixes');
