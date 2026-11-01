# Delaware Mandir workshop — setup and rollout

All project files are inside MandirTickets, including the staff-dashboard subfolder. The live GitHub Pages site and its Google Apps Script deployment have **not** been changed.

## Workflow

1. A requester submits printing or foam details and artwork. The receipt says **Awaiting admin review**. The public live queue shows **In Review** until approval, without a production position. No paper-material selector appears on the public form.
2. An admin signs in and opens **Admin review**. They can open artwork and correct requester name, department, purpose, quantity, dimensions, foam thickness, notes, request type, and artwork attachments. Corrected files can be linked from the private workshop Google Drive folder. Local attachments can be renamed or removed.
3. The admin saves corrections, approves for production, or declines with a reason. The interface requires confirmation that artwork, sizes, and quantity were checked. Edits and decisions are recorded in history; concurrent edits cannot overwrite a newer revision.
4. Approved requests enter the staff printing or foam queue. Submission time provides the default order, but staff can start any approved job, including several jobs being worked on. Positions are advisory, not promised completion times.
5. Staff record actual material used and waste, then mark ready for pickup, collected, or cancelled. Cancellation requires a reason. Closed, cancelled, and declined tickets can be archived from their ticket detail; archived tickets leave the normal History and All tickets views but remain searchable under Archive with their files, material records, and status history retained.
6. Telegram is required for every requester. Once the ticket is saved, the receipt shows the secure ticket-specific Telegram handoff; the requester opens it and presses Start before they can begin another submission. Telegram proactively sends **ready for pickup** and **declined** updates; declined messages include the admin’s reason. `/status` returns current state, and `/pickup P-0001` lets the linked requester confirm collection and move a ready ticket to the closed/collected state. The registered private admin group receives every new ticket, ready/declined changes, and requester pickup confirmations.

The workflow does not send commands to the printer or foam cutter. Trained volunteers operate the machines. Material totals measure recorded consumption, not remaining inventory, ink levels, or automatic machine telemetry.

## GitHub Pages staff access

The GitHub Pages deployment connects the staff dashboard directly to Apps Script. Its sign-in screen is a browser-local gate and does not require `WORKSHOP_SHARED_SECRET`, `APP_ORIGIN`, `STAFF_API_URL`, or a Node server. The Pages workflow passes the existing `VITE_GOOGLE_SCRIPT_URL` into both frontend builds.

After entering the staff screen, the dashboard opens the review workspace and production tools. The typed volunteer name is saved as a history label. Ticket reads retry transient Apps Script failures and have a JSONP fallback; writes use a single POST so an uncertain response cannot automatically replay a status or review mutation.

The optional Node deployment remains in the repository but is not required for this mode.

## Telegram bot

Telegram runs entirely from the existing Apps Script project. New submissions and ready/declined changes made in the dashboard attempt delivery immediately; a one-minute installable trigger handles bot commands, pickup confirmations, retries, and fallback delivery. No phone, SIM, SMS account, Node server, webhook host, or additional deployment is required.

1. Create the bot with `@BotFather`. Treat the bot token like a password. If it is ever pasted into chat, email, source code, or an issue, revoke it and create a replacement.
2. Add the fresh token as the `TELEGRAM_BOT_TOKEN` Apps Script Property. Never put it in the React build, repository, or Sheet.
3. Save the updated Apps Script source and run `setupTelegramNotifications`. It verifies the bot, records its username, disables webhook mode, installs the one-minute trigger, and displays a one-time staff registration command.
4. Add the bot to the private staff group and send the displayed `/registerstaff ...` command within 24 hours. The bot confirms registration on its next polling run.
5. Use **Ticket system → Send Telegram staff test**. This verifies that the bot can actually post to the registered group; a registered chat ID alone does not confirm posting permission. **Show Telegram setup status** also reports the latest staff delivery state.
6. Publish a new version of the existing web deployment. The public form marks Telegram as required and the backend rejects submissions without the required browser key or bot configuration. After a successful save, the receipt provides **Continue to Telegram** plus a QR code and keeps **Open another ticket** disabled until the bot confirms the connection. The link stays valid for 14 days and contains a random one-time token whose SHA-256 hash—not the token—is stored privately. The browser keeps a random key so later tickets can reconnect to the same chat automatically. On a shared computer, choose **use a different Telegram account** before submitting.
7. Submit and link a ticket, then test `/status`, a ready ticket, `/pickup P-0001`, and a declined ticket. Confirm pickup moves the ticket to the closed list, adds requester history, and alerts the admin group; confirm the declined message includes the saved reason.

Requester chat IDs and delivery state live in hidden `Telegram Subscriptions` and `Telegram Outbox` tabs. Admin-group new-ticket messages contain the complete submitted request and private Drive links; members still need Drive permission to open the artwork. Keep this group private and limited to authorized workshop staff because these alerts can contain personal and project information. Long submissions are split into numbered messages instead of being truncated. Requester ready and decline messages name the job, quantity, size, purpose, and file names, but never include Drive links. Staff ready and declined messages also show the requester, who made the change, and whether the requester is linked to Telegram. Decline messages contain the admin-entered reason. Phone numbers are not sent to Telegram. Successful API responses are recorded as `sent`, but do not prove the person read the message. Telegram rate limits and temporary server failures receive bounded retries. Interrupted sends become `unknown` and are not automatically repeated, preventing an uncertain pickup message from being duplicated. Telegram failures never roll back a ticket status change.

## Existing live system

Public site: [MandirTickets](https://shailp08.github.io/MandirTickets/).

Existing Apps Script deployment:

```
https://script.google.com/macros/s/AKfycbwpy_peP9T_gYF6blc1EnCvVn-TqvFhXHgiW_d9s5c4sDLx61U56ANTLTawZUQ0ic8p/exec
```

The existing read-only health check succeeded earlier. The new admin/staff endpoints still require deployment. No live tickets were created or changed during development.

To find the editor, open the ticket Google Sheet and choose **Extensions → Apps Script**. If the Sheet is owned by someone else, its owner must provide access or apply the update. The public deployment URL does not grant editor access.

## Rollout order

1. Back up the ticket Sheet and existing Apps Script source; retain the previous deployment version for rollback.
2. Replace the existing ticket script with `MandirTickets/integrations/google-sheets.gs`. Preserve existing Script Properties, Sheet ID, upload-folder ID, and allowed upload origins. **Do not run new-system setup or create a replacement Sheet.**
3. Put a newly generated bot token directly in the `TELEGRAM_BOT_TOKEN` Script Property, run `setupTelegramNotifications`, add the bot to the private staff group, and complete the one-time group registration command. Do not paste the token into chat or source code.
4. Publish a new version of the **existing deployment**, keeping its `/exec` URL. The script preserves the legacy email, cost, and SMS columns, and stores Telegram subscriptions/delivery attempts in separate hidden tabs. Existing receipt codes, IDs, timestamps, costs, and Drive links are preserved.
5. Before opening the staff desk, run `holdUnreviewedQueueForAdminReview` from the script editor if the existing queued backlog has not already been approved. It moves only unstarted queued requests without an approval history into review. Active, ready, collected, and cancelled work is preserved. It is safe to rerun without duplicating these holds. Direct Sheet changes bypass application review, revision controls, and Telegram event generation; use the app afterward.
6. In GitHub repository variables, retain `VITE_GOOGLE_SCRIPT_URL` with the existing `/exec` URL. `STAFF_API_URL` may remain empty. Run the **Verify and deploy GitHub Pages** workflow; it passes the Apps Script URL to both the public form and staff dashboard.
7. Verify a clearly labeled real request for each machine with the coordinator: submit, complete the required Telegram handoff, and confirm the private staff group receives each new-ticket alert and can open its Drive links. Confirm `/status`, edit/approve, start, log material, mark ready, collect the work, and send `/pickup` to close it. Archive the closed test ticket and confirm it moves from History to Archive without losing its details. Also test one decline and confirm its reason appears for both the requester and staff group.

Google Drive artwork remains private. Give authorized admins/staff access to the existing workshop folder; the app does not make files public.

## Optional private-server configuration

The following is only for a future Node-hosted deployment. It is not needed for the GitHub Pages-only pipeline:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
APP_ORIGIN=https://YOUR-STAFF-HOST
COOKIE_SECURE=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=SET-PRIVATELY
STAFF_USERNAME=workshop
STAFF_PASSWORD=SET-PRIVATELY
WORKSHOP_GOOGLE_SCRIPT_URL=THE-EXISTING-EXEC-URL
WORKSHOP_SHARED_SECRET=THE-SAME-VALUE-AS-SCRIPT-PROPERTIES
PUBLIC_REQUEST_URL=https://shailp08.github.io/MandirTickets/
DATA_DIR=/app/data
UPLOAD_REQUEST_TIMEOUT_MS=900000
SHEETS_WEBHOOK_URL=
SHEETS_SHARED_SECRET=
```

Mount durable storage at `/app/data` with write access for the application user. Keep one server instance. Sessions last eight hours and are cleared on restart. The Google Sheet remains the source of truth for tickets, review history, material usage, and Telegram delivery state. Google failures never create a replacement local production queue.

The archive contains one `MandirTickets` folder. From inside that folder:

```bash
docker build -f deploy/Dockerfile -t mandir-workshop .
```

The Dockerfile is prepared but has not been built here. The application builds were verified directly. No hosting account has been created or charged, and no live deployment has been performed.

## Local checks

Use Node 22 or newer. Run these commands from MandirTickets:

```bash
npm run setup
npm run check
npm start
```

For a separate local test database, leave `WORKSHOP_GOOGLE_SCRIPT_URL`, `SHEETS_WEBHOOK_URL`, and legacy Textbee credentials blank; set `HOST=127.0.0.1` and point `DATA_DIR` to a test directory. Open `http://localhost:3000/` and `/staff/`. Telegram receipt links are issued only by a configured Apps Script backend. Local mode is for development, not a replacement for the live Google system. Local-upload production mode additionally requires the existing ClamAV configuration.

Dashboard-only tests, from MandirTickets:

```bash
npm run test:staff
```

## Verification

Both production builds passed. The backend suite passed 129 tests and the dashboard/library suite passed 194 tests. Checks cover the deployed Apps Script health check, optional phone and size fields, inline and resumable uploads, queue transport fallback, approval gating, editable fields, stale revisions, file-path restrictions, flexible production ordering, privacy, upload validation, material-entry retries, and duplicate-send prevention. The existing local-data audit passed with two tickets, two files, and no orphaned files.

Browser checks used a separate sample database and confirmed both configured accounts, simplified admin review fields, awaiting-review receipts, admin corrections/approval, staff starting a later job, material usage, pickup status, and public live-queue behavior. Telegram unit coverage verifies required one-time hashed receipt links, command parsing, requester pickup closure, staff new-ticket file links, decline-reason delivery to both audiences, and bounded retries. A live bot delivery test still requires the fresh token and private staff group. Sample data and credentials are excluded from the archive. Existing Create React App maintenance warnings remain; builds and tests pass.

Still needed for launch: revoke any exposed bot token, add the fresh token to Apps Script Properties, run Telegram setup, register the private staff group, publish a new version of the existing Apps Script deployment, and rerun the GitHub Pages workflow. A private Node host is not required.
