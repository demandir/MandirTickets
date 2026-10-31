# Production audit

Reviewed October 16, 2026.

## Scope

The review covered the React client, Express endpoints, session boundary, origin checks, uploads, content validation, persistent store, queue privacy, status revisions, Google Sheets replication, CSV export, static deployment, and recovery behavior.

## Findings resolved

### GitHub Pages could not load a repository-subpath build

The client used root-relative assets and same-origin API URLs. The Vite build now emits relative assets, bundles the Geist font, and accepts `VITE_API_BASE_URL` for a separately hosted API. An unconfigured Pages build displays a frontend-preview notice.

### A Pages frontend could not authenticate to an API host

The server rejected all cross-site mutations, did not return CORS headers, and issued `SameSite=Strict` staff cookies. It now permits credentialed requests only from the exact configured `APP_ORIGIN`, handles preflight requests, and uses secure `SameSite=None` cookies only when the frontend and API origins differ.

### Upload capacity was unbounded

Upload concurrency was bounded, but per-request file count and file size were not. Configurable limits now default to ten files and 250 MiB per file. Multer failures clean up partially accepted files before returning a specific client error.

### Legacy records could break exports or the staff desk

Old records without `files` or `history` arrays were not fully normalized. Store startup now supplies safe empty arrays. A separate privacy-preserving data audit detects duplicate identifiers, invalid statuses and revisions, malformed history, missing referenced uploads, unsafe names, and orphaned files.

### Public-source hygiene needed work

The obsolete pre-React frontend was still copied into the production artifact, and integration notes contained a specific private Sheet identifier. The dead client was removed and the Sheets documentation now uses installation-specific placeholders. Secret-pattern scanning reports no committed credentials.

### GitHub Pages had no persistent backend

The static Pages build could display the request form but could not save tickets. A bound Google Apps Script backend now writes validated tickets to a private Sheet, stores bounded attachments in a private Drive folder, issues idempotent sequential ticket numbers, and exposes bounded JSONP endpoints for receipt confirmation and the public live queue. Those public responses return no contact information or file details.

## Verification

- Production Vite build succeeds with repository-relative assets.
- All 34 automated tests pass.
- Dependency audit reports zero known production vulnerabilities.
- The HTTP suite verifies health, login, upload, idempotency, download authorization, privacy, status revisions, export, cross-origin preflight, secure cross-site cookies, and upload-limit cleanup.
- The persistence suite verifies concurrent numbering, restart behavior, legacy sequences, atomic updates, stale-write rejection, status history, Sheets retry behavior, and CSV formula escaping.
- The upload suite verifies filename restrictions, unrestricted non-empty SVG acceptance, ASCII DXF structure, PDF/image envelopes, hashing, and fail-closed malware scanning.
- The configured local data directory passes the integrity audit with no errors or orphaned files.

## Remaining operational requirements

The Google Sheet and Drive folder must remain private and should be covered by the Google Workspace retention and backup policy. Staff should treat uploaded files as untrusted. Apps Script checks print-file envelopes and ASCII DXF structure, but deliberately accepts all non-empty `.svg` contents and does not provide ClamAV malware scanning. SVG files must remain downloads and must never be rendered inline in a browser. The default daily circuit breaker and Apps Script quotas suit a small controlled workshop, not a high-volume public service.

The optional Node deployment still requires an HTTPS host, persistent storage, current ClamAV signatures, backups, disk monitoring, individual staff identities for broader use, an external session store, request-abuse controls at the edge, and multiple-instance-safe database storage.
