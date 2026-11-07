import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const destination = path.join(root, 'dist', 'staff');
const configuredUrl = loadEnv('production', root, 'VITE_STAFF_SITE_URL').VITE_STAFF_SITE_URL?.trim();
const staffUrl = configuredUrl && URL.canParse(configuredUrl) ? new URL(configuredUrl) : null;
if (configuredUrl && (!staffUrl || staffUrl.protocol !== 'https:' || staffUrl.username || staffUrl.password || staffUrl.search || staffUrl.hash)) {
  throw new Error('VITE_STAFF_SITE_URL must be an HTTPS dashboard URL without credentials, a query, or a fragment.');
}

const href = staffUrl?.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mandir Workshop Desk</title>${href ? `\n  <meta http-equiv="refresh" content="0; url=${href}">` : ''}
</head>
<body>
  <main>
    <h1>Mandir Workshop Desk</h1>
    ${href ? `<p><a href="${href}">Continue to the staff sign-in</a></p>` : '<p>The staff sign-in is being configured. Contact the workshop coordinator for access.</p>'}
    <p><a href="../">Return to the public ticket site</a></p>
  </main>
</body>
</html>
`;

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
await fs.writeFile(path.join(destination, 'index.html'), html);
console.log(`Packaged staff entry page in ${path.relative(root, destination)}/`);
