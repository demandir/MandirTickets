# Delaware Mandir Workshop Tickets

Everything is inside this folder: the public request site, admin/staff dashboard, Google integration, and staff server deployment files.

- `src/`: public request form and live queue.
- `server.js` and `lib/`: staff authentication, review workflow, and material records.
- `integrations/google-sheets.gs`: live Sheets/Drive backend and Telegram notification worker.
- `staff-dashboard/`: admin/staff interface and existing prototype files.
- `integrations/`: Google Apps Script backend.
- `deploy/`: container configuration.

## Run from this folder

Use Node 22 or newer. For the GitHub Pages build, set `VITE_GOOGLE_SCRIPT_URL` to the Apps Script `/exec` URL, then:

```bash
npm run setup
npm run build:pages
```

`setup` installs both applications' exact dependencies. `build:pages` builds both applications and packages the public request site in `dist/`. Its `/staff/` entry links to the HTTPS dashboard URL configured in `VITE_STAFF_SITE_URL`.

```bash
npm run build:all
npm run test:all
npm run check
```

`check` runs both builds, both test suites and the local-data audit. The dashboard retains its own package manifest because it uses a different React/toolchain version. All files and dependencies are inside this project; there are no sibling-folder dependencies.

GitHub Pages uses `VITE_GOOGLE_SCRIPT_URL` for public requests. The staff dashboard is served by the Node server, which connects to the same deployment using `WORKSHOP_GOOGLE_SCRIPT_URL` and the server-only `WORKSHOP_SHARED_SECRET`. See [setup and rollout](docs/workshop-setup.md) before updating the live system.

## Container

From this folder:

```bash
docker build -f deploy/Dockerfile -t mandir-workshop .
```

The included `.dockerignore` excludes private credentials, dependencies and data. See the setup guide for HTTPS hosting, persistent storage, account settings, and Telegram activation.
