# Google Sheets ticket backend

This backend makes the GitHub Pages site operational without publishing the spreadsheet. Ticket details stay in a private Google Sheet, attachments stay in a private Google Drive folder, and the public site exposes only the live queue plus each submitter's private receipt.

## Create and deploy the backend

1. Create a new private Google Sheet named **Mandir Workshop Tickets**.
2. In that sheet, choose **Extensions → Apps Script**.
3. Replace the editor contents with [`google-sheets.gs`](google-sheets.gs) and save it.
4. Select `setupMandirTicketSystem` in the function menu and click **Run**. Approve access to the current spreadsheet and Google Drive. Setup creates the `Tickets` tab and a private Drive folder for attachments.
5. Choose **Deploy → New deployment → Web app**.
6. Set **Execute as** to yourself and **Who has access** to **Anyone**. Deploy and copy the URL ending in `/exec`.
7. In the GitHub repository, open **Settings → Secrets and variables → Actions → Variables** and create `VITE_GOOGLE_SCRIPT_URL` with the `/exec` URL.
8. Re-run the **Verify and deploy GitHub Pages** workflow.

The workflow also supplies the same Apps Script URL to the staff dashboard under `/staff/`. In this GitHub Pages-only mode, ticket lists are read directly from Apps Script with bounded retries and a JSONP fallback, and staff mutations are sent directly to the same deployment. No Node server or shared secret is required.

Never publish the spreadsheet, share the upload folder, commit the deployment URL as source code, or add a client-side secret. The web app is intentionally public so visitors can create tickets and view the live queue; private receipt identifiers remain backend-only.

## Telegram notifications

Telegram is required for every public ticket. It uses the same Apps Script project, so no Node server or additional host is required. New submissions and dashboard changes to **ready for pickup** or **declined** attempt delivery immediately, while a one-minute trigger handles bot commands, retries, and fallback delivery. Requesters use `/status` to check work and `/pickup P-0001` after collection to move a ready ticket to the closed/collected state. The registered private admin group receives every new ticket as a formatted summary of all submitted information and private Drive file links, plus ready, declined, and requester-confirmed pickup updates. Staff can query a ticket with `/status P-0001`.

1. Create the bot with `@BotFather`. If its token was ever pasted into chat, email, a ticket, or source code, revoke it and generate a replacement before continuing.
2. In **Apps Script → Project Settings → Script Properties**, add `TELEGRAM_BOT_TOKEN` with the fresh token. Do not put it in this repository or any Sheet cell.
3. Save the current `google-sheets.gs`, select `setupTelegramNotifications`, and click **Run**. Approve the external-request and trigger permissions. The setup verifies the token, records the bot username, switches off webhook mode, creates the private subscription/outbox tabs, and installs the one-minute trigger.
4. Read the registration command shown by the setup dialog. Add the bot to the private staff group and send that one-time `/registerstaff ...` command in the group within 24 hours.
5. Wait up to one minute for the bot to confirm that the group is registered. Use **Ticket system → Show Telegram setup status** to verify the bot, trigger, and staff group.
6. Use **Ticket system → Send Telegram staff test**. If it fails, the error identifies a stale group registration or missing bot posting permission. Setup status also shows the latest staff delivery journal entry.
7. Publish a new version of the existing Apps Script web deployment, keeping the same `/exec` URL, and rebuild the GitHub Pages site.
8. Submit a test ticket, use the required **Continue to Telegram** handoff, press Start, and confirm that the receipt unlocks after the bot processes the link. Confirm `/status`, then mark the ticket ready, collect it, and send `/pickup P-0001`; verify that the ticket moves to the closed list and the private staff group receives the pickup confirmation. Also exercise one declined test.

The requester is told before submission that Telegram is required. Because Telegram bots cannot attach a ticket to a username on their own, the saved-ticket confirmation provides the ticket-specific **Continue to Telegram** link and the requester presses Start in the private bot chat. The receipt polls for confirmation and does not allow another submission until Telegram is linked. The link uses a random one-time token valid for 14 days, and only its SHA-256 hash is stored. Telegram chat and user IDs are kept in the hidden `Telegram Subscriptions` tab; delivery attempts are journaled in `Telegram Outbox`. Ready messages include the ticket-specific `/pickup` command; the bot authorizes the linked private chat, accepts pickup only from the ready state, records the requester action in history, and moves the ticket to closed/collected. Admin-group new-ticket messages contain all submitted requester and job information, notes, and private Drive file links; long submissions are split into numbered messages rather than truncated. Keep the registered group private and limited to authorized workshop staff. Drive permissions still control who can open each file link.

A successful Telegram API response is recorded as `sent`; it does not prove that the user read the message. Rate limits and temporary Telegram failures receive bounded retries. An interrupted/ambiguous send is recorded as `unknown` and is not automatically repeated, avoiding duplicate pickup messages. Ticket status changes never fail because Telegram is unavailable.

## Daily workflow

- Open the private **Mandir Workshop Tickets** spreadsheet in Google Drive and use the `Tickets` tab as the staff queue. Do not link the private sheet from the public website.
- New submissions appear as one row with status `pending-review`. The most useful staff columns are Queue number (B), Name (D), Purpose (F), Needed by (M), Status (N), and Files (P).
- Use the staff dashboard to move requests through `queued`, `in-progress`, `ready`, `collected`, or `cancelled`. Closed, cancelled, and declined tickets can then move to `archived`; the dashboard retains them in its Archive view while removing them from normal History and All tickets views. The public live queue reflects active status changes.
- Telegram staff alerts are queued for each new submission. Ready/declined notifications and requester pickup confirmations are queued from history changes; all normally send immediately, with the one-minute worker as a fallback. Treat the Sheet as a private record; direct status-cell edits do not create a staff-history event and therefore do not send Telegram updates.
- To print the submitted artwork, open its private Drive link in Files (column P), then print or download it from the Drive preview.
- To print the ticket details, select the cells in that ticket's row, choose **File → Print**, and set **Print** to **Selected cells**. Landscape orientation is usually easiest to read.
- The hidden Ticket ID, Tracking code, Request key, and Request fingerprint columns support integrity and idempotency. Do not delete or reuse them.
- Use **Ticket system → Audit ticket files** to verify that every Sheet file link still points to a non-empty, checksummed file in the private Drive folder.
- Use **Ticket system → Clean abandoned uploads** after interrupted submissions to move pending files older than 24 hours to Drive trash.

## Reliability target

This deployment assumes one workshop, internal PII, fewer than one request per second at peak, and more live-queue reads than ticket writes. The operational target is 99.5% monthly availability, with backend handshake latency excluding file-transfer time of p50 ≤ 2,500 ms, p95 ≤ 15,000 ms, and p99 ≤ 60,000 ms. The recovery point objective is zero loss for tickets that displayed a receipt; the recovery time objective is four hours. The workshop site owner is the named error-budget owner and should run the file audit after backend changes or any reported upload failure.

The live queue reads only the first 17 source columns and projects just the public queue fields, caches that response for 60 seconds, and invalidates the cache after ticket or staff updates. Cache fills and mutations share a lock so a cold read cannot republish a stale snapshot after an update. A cache outage or oversized snapshot falls back to a fresh Sheet read instead of taking the queue down. Browsers retain the last successful snapshot for up to five minutes so a reload can render immediately while a fresh request is in flight.

The public backend accepts up to five files and 200 MB total. Poster-printing tickets accept PDF, JPG, PNG, or TIFF; foam-cutting tickets accept any non-empty file named `.svg` or a structurally valid ASCII DXF. SVG and DXF files are limited to 10 MB each. SVG contents are stored exactly as supplied and are not parsed or sanitized, so staff must treat them as untrusted downloads and must never render them inline in a browser. Vector files up to 5 MB (up to 10 MB combined) travel with the ticket request and are written to the private Drive folder by Apps Script, so they do not depend on a browser resumable-upload handshake. Larger files use private, resumable Google Drive sessions and are re-read from Drive for byte-count and integrity checks before the ticket is saved. Google Apps Script is suitable for a small workshop; its quotas, a default 250-ticket daily circuit breaker, and a default 5 GiB daily upload reservation limit reduce abuse. Set different positive `MAX_DAILY_TICKETS` or `MAX_DAILY_UPLOAD_BYTES` script properties only if needed. Set `UPLOAD_ORIGINS` to a comma-separated origin allowlist if the frontend is hosted somewhere other than the included GitHub Pages site or local development addresses.

When upgrading an existing deployment from the original small-file backend, run `authorizeLargeFileUploads` once from the Apps Script editor and approve the added external-request permission before deploying the new version.

## Updating the backend

After changing `google-sheets.gs`, update the Apps Script source, save, then choose **Deploy → Manage deployments → Edit → New version → Deploy**. Existing `/exec` URLs continue working.

The script also accepts the original Node server’s authenticated 19-column sync payload when `SHARED_SECRET` is set as a script property. Most GitHub Pages installations do not need that compatibility path.

Official deployment guide: https://developers.google.com/apps-script/guides/web
