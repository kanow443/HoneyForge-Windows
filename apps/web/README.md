# HoneyForge frontend

Requires Node 22.12+ and FastAPI control service at http://127.0.0.1:8100.

```sh
cd apps/web
npm ci
npm run dev
```

Open http://localhost:5173. Credentials are configured by the control service; the frontend has no hardcoded password.

```sh
npm test
npm run build
```

For deployment, serve dist with SPA fallback to index.html. Proxy /api and /health to the control service on the same origin. Preserve cookies/CSRF headers and support long-lived SSE without buffering. A live demo requires an enrolled Linux agent with Docker and reachable trap ports. Publish a profile, select a host, then deploy through Deployments.

Constructor preview is local and marked accordingly. Runtime events/findings come from the API. Acceptance evidence/references are in ../../docs/evidence/frontend.

Motion uses shared timing in `src/app/motion.css` and small browser-native helpers in `src/shared/ui/motion.tsx`, with no animation dependency. Navigation/tab indicators track their controls on resize; view changes animate existing DOM nodes to preserve editor focus and drafts. Dialogs animate both opening and closing and restore focus to their opener. System reduced-motion preferences disable CSS effects and cancel active content animations. Live background refreshes do not replay page transitions.

All native buttons, links, disclosures, checkboxes and ranges share interaction feedback. Shared panels animate first appearance and explicit `motionKey` changes, so filtering, host selection, profile versions and deployment previews respond without replaying on polling. Collapsible filters and file folders retain controls and values while closed content is inert. Overview, authentication, cases, source restrictions, reports and audit use the same restrained motion defaults.
