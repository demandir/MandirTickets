# Delaware Mandir Workshop Desk

Staff interface for the MandirTickets backend. Printing and foam-cutting tabs share the live Google-backed ticket records through the authenticated Node server. The desk includes an admin review inbox, editable request details, approval/decline decisions, flexible work queues, ticket details and artwork links, pickup workflow, material/waste entries, usage totals, and CSV export.

## Build and serve

Use Node 22+. From the parent `MandirTickets` folder, run `npm run setup` and `npm start` to build and serve both applications locally. The Node server serves the dashboard at `/staff/`.

For production, host the Node server over HTTPS and point the public site's `VITE_STAFF_SITE_URL` to that server's `/staff/` page. See the [rollout guide](../docs/workshop-setup.md).

## Tests

```bash
CI=true npm test -- --watchAll=false --runInBand
```

## Existing prototype

The original interface is preserved in `src/LegacyPrototype.tsx`; its old components, print bridge, inventory store, and related tests remain. It is not mounted by the production app. The shared desk does not use its mock hardware readings, local-only inventory, manual reorder, or rush shortcuts. The new material ledger records consumption, not remaining stock.
