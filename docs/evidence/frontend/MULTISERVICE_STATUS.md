# Frontend v3 bundle and High delivery

Updated 2026-10-10T23:51:14.974618+00:00. Current result: frontend source/build complete; actual group and profile UI checks PASS. Existing release/gateway/Windows package needs root-owned rebuild and verification against this artifact. This proof supersedes the older frontend release marker for the scope below, without claiming a packaged release.

## Implemented

- Profile schema v3, 2–8 services: add/remove/reorder, unique keys/ports, shared hostname/persona, existing HTTP/Cowrie/TCP and new cowrie-high settings, per-service CodeMirror files/resources/preview. Undo/redo and tab-local draft restoration; publish/edit immutable versions.
- Actual deployment-groups API: reviewed request, stable idempotency key on unchanged retries, occupied/duplicate port validation, all-service host capability checks, actual aggregated and individual state/error display, whole-group stop and compatible-version redeploy with retained ports. Single v1/v2 flows retained; individual group-child redeploy directs to group.
- Separate High adapter in both builders and profile chooser. Default published OpenSSH banner, blocked-only downloads, separate cowrie-high capability required. Short notice distinguishes proxy readiness and guest boot delay; local preview explicitly identifies itself as an example. These frontend runs did **not** deploy or verify a guest OS.
- Geo/ASN displays actual availability, provider, age and stale state; DB-IP link and CC BY 4.0 attribution. No invented public sources or countries for private addresses. License checked against [DB-IP Lite official terms](https://db-ip.com/db/lite.php).
- Generated TypeScript schemas refreshed from actual API OpenAPI, including BundleProfile, ProfileService, HighSshProfile, DeployGroup, DeploymentGroupView and Geo metadata. No backend files edited.

## Verification

- 135 tests / 29 files PASS; TypeScript compilation PASS; production build PASS. Main entry 497.51 kB / 155.40 kB gzip, CodeMirror editor remains lazy.
- Final real browser bundle run `715395af`: all 7 checks PASS — per-service local edits/undo/reordering; actual v3 publication; real agent-confirmed 3-service group; HTTP200 and SSH/TCP banner bytes; whole-group stop; publish v2 while v1 remains immutable and redeploy retains ports; Geo attribution. Group `1a80126f-5ba1-4400-9f86-a805271950d9` confirmed stopped, own profile archived.
- Final High browser run `85c141e3`: actual single High publication, correct host capability picker, actual v3 High-service publication and combined host compatibility. Both own profiles archived. This verifies the frontend/API contract, not High guest execution.
- 16 viewport checks across editor/profile/deploy/group/Geo/High at 390 and 1280: no document overflow. Screens visually inspected at both widths.
- One intermediate group run did not reach Running while the sensor was changing runtime state; preserved as multiservice-runtime-interrupted.json, with cleanup confirmed. Final fresh run passed. Earlier 202 stop-response mismatch corrected; initial successful runtime checks preserved separately with independent stopped-state reconciliation.

## Evidence

- multiservice-ready.json — compact handoff flags; multiservice-dist-manifest.json — 42 files and individual SHA-256 values, manifest digest `9b5bc202a0116c82f4f54351436af7de3145860103fbdb1ea7e1ff40e6f92492`.
- multiservice-browser.json, high-browser.json — final API/browser checks, IDs, widths and cleanup.
- multiservice-tests.txt, multiservice-build.txt — final checks.
- multiservice-editor-1280.png / -390.png, multiservice-group-1280.png / -390.png and high-editor-1280.png / -390.png — rendered product evidence. Other profile/deploy/Geo screenshots use the same naming convention.

All changes are limited to apps/web and docs/evidence/frontend. No commits, no backend/infra writes, no modification to Operations/Scale/Acceptance resources. Root owns packaging/deployment.
