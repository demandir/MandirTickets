# Delaware Mandir workshop — setup and rollout

The public request site uses GitHub Pages. The staff dashboard uses an authenticated Node server. Both use the existing Google Sheet and Drive folder through Apps Script.

## Workflow

1. A requester submits printing or foam details and artwork. The receipt says **Awaiting admin review**. The public live queue shows **In Review** until approval, without a production position. No paper-material selector appears on the public form.
2. An admin signs in and opens **Admin review**. They can open artwork and correct requester name, department, purpose, quantity, dimensions, foam thickness, notes, request type, and artwork attachments. Corrected files can be linked from the private workshop Google Drive folder. Local attachments can be renamed or removed.
3. The admin saves corrections, approves for production, or declines with a reason. The interface requires confirmation that artwork, sizes, and quantity were checked. Edits and decisions are recorded in history; concurrent edits cannot overwrite a newer revision.
4. Approved requests enter the staff printing or foam queue. Submission time provides the default order, but staff can start any approved job, including several jobs being worked on. Positions are advisory, not promised completion times.
5. Staff can review and approve a saved ticket immediately, even while its requester is still completing the Telegram handoff. Staff record actual material used and waste, then mark ready for pickup, collected, or cancelled. Cancellation requires a reason. Closed, cancelled, and declined tickets can be archived from their ticket detail; archived tickets leave the normal History and All tickets views but remain searchable under Archive with their files, material records, and status history retained.
6. Telegram is required for every requester. Once the ticket is saved and available to staff, the receipt shows the secure ticket-specific Telegram handoff; the requester opens it and presses Start before they can begin another submission. Telegram proactively sends **ready for pickup** and **declined** updates; declined messages include the admin’s reason. `/status` returns current state, and `/pickup P-0001` lets the linked requester confirm collection and move a ready ticket to the closed/collected state. The registered private admin group receives every new ticket, ready/declined changes, and requester pickup confirmations.

The workflow does not send commands to the printer or foam cutter. Trained volunteers operate the machines. Material totals measure recorded consumption, not remaining inventory, ink levels, or automatic machine telemetry.

## Staff access

The Node server serves `/staff/`, verifies staff and admin credentials, and uses a private shared secret to access Apps Script. The Pages `/staff/` URL directs staff to that server using `VITE_STAFF_SITE_URL`. The typed volunteer name is recorded as a history label.

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

The public site is [MandirTickets](https://demandir.github.io/MandirTickets/). Use the production `VITE_GOOGLE_SCRIPT_URL` Actions variable in `demandir/MandirTickets` to identify the existing Apps Script `/exec` deployment. Open the ticket Google Sheet and choose **Extensions → Apps Script** to edit its source.

## Rollout order

1. Back up the existing ticket Sheet and Apps Script source. Compare the live script with `integrations/google-sheets.gs` before updating it. Preserve the Sheet, Drive folder, and existing Script Properties.
2. In **Apps Script → Project Settings → Script Properties**, set `WORKSHOP_SHARED_SECRET` to a random value of at least 32 characters. If `UPLOAD_ORIGINS` is configured, include `https://demandir.github.io` as an origin with no path or trailing slash. An explicit list overrides the new default.
3. Deploy the staff Node server with the settings below and verify staff and admin sign-in at its HTTPS `/staff/` URL. Use the same Apps Script URL and `WORKSHOP_SHARED_SECRET` on the server. Check that the staff dashboard can read the live queue before switching staff over.
4. Update the existing Apps Script source with `integrations/google-sheets.gs`. In **Deploy → Manage deployments**, edit the existing web app and select **New version** so its `/exec` URL stays the same. The old public staff dashboard loses access as soon as this version is live.
5. In **GitHub → Settings → Secrets and variables → Actions → Variables**, keep `VITE_GOOGLE_SCRIPT_URL` on the existing deployment and set `VITE_STAFF_SITE_URL` to the new HTTPS dashboard URL including `/staff/`. The Pages workflow skips deployment when the staff URL is blank. Run **Verify and deploy GitHub Pages** on `main` after setting the variable if the branch was already merged.
6. In the Sheet's **Ticket system** menu, use **Show Telegram setup status** and **Send Telegram staff test**. If the token found in old Git history was never revoked, rotate it through `@BotFather` and store the replacement in the existing `TELEGRAM_BOT_TOKEN` property first.
7. Submit a clearly labeled PDF test ticket with the coordinator. Confirm the file opens from Drive, an admin can approve the request, staff can record material use and mark it ready, and the requester receives the Telegram message. Use `/pickup` to close it and archive the test ticket.

Google Drive artwork remains private. Give authorized admins/staff access to the existing workshop folder; the app does not make files public.

## Staff server configuration

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
PUBLIC_REQUEST_URL=https://demandir.github.io/MandirTickets/
DATA_DIR=/app/data
UPLOAD_REQUEST_TIMEOUT_MS=900000
SHEETS_WEBHOOK_URL=
SHEETS_SHARED_SECRET=
```

Mount durable storage at `/app/data` with write access for the application user. Keep one server instance. Sessions last eight hours and are cleared on restart. The Google Sheet remains the source of truth for tickets, review history, material usage, and Telegram delivery state. Google failures never create a replacement local production queue.

From the repository root:

```bash
docker build -f deploy/Dockerfile -t mandir-workshop .
```

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
