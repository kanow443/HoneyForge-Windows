# LIVE iteration: shared backend/frontend contract

Implemented and verified on the local lab on 2026-10-10; see BACKEND_STATUS.md / FRONTEND_STATUS.md for exact acceptance boundaries. Backend owns src/infra/tests/scripts/packages/contracts. Frontend owns apps/web and frontend evidence/status. Preserve the finished constructor. All new screens consume real API data; no synthetic attacks in the UI.

## Endpoints being implemented

* `GET /api/v1/sessions/{id}/playback?after=0&limit=500`: `{items: EventView[], total: number, next_cursor: number, watermark: number, has_more: boolean}`. EventView adds `ingest_position: number`. Pagination order is ingest_position (durable committed ingestion order); presentation may sort by source_seq/observed_at/id. After a complete page next_cursor equals snapshot watermark. Always fetch all pages before treating history as complete. SSE invalidates query keys `session`, `sessions`, `playback`, `topology`, `blocks`, `cases`, `report`.
* `GET /api/v1/topology?hours=24`: `{hosts: HostView[], deployments: DeploymentView[], sources: [{source_ip,event_count,last_seen}], links: [{source_ip,deployment_id,event_count,last_seen,severity,session_id}], sessions: SessionView[], watermark, since, until, truncated: boolean}`. At most 100 sources / 200 links / 100 recent sessions. Severity: `none|low|medium|high`; session_id can be null. Topology represents inbound observations, not geographic attribution or proved client identity. Filter map/list together; latest session link opens player.
* `GET /api/v1/source-blocks?deployment_id=<uuid>`: `SourceBlockView[]`.
* `POST /api/v1/source-blocks`, CSRF and `Idempotency-Key` required: `{deployment_id, source_ip, ttl_seconds:60..3600, reason:1..500 chars}` → SourceBlockView, 202.
* `POST /api/v1/source-blocks/{id}/cancel`: `{revision: number}` → SourceBlockView, 202. Revision fences stale cancellation.
* SourceBlockView: `{id,created_at,deployment_id,host_id,generation,source_ip,reason,expires_at,desired_state:'blocked'|'released',revision,observed_revision,observed_state:'pending'|'applied'|'released'|'error',observed_at,error,created_by,state:'pending'|'applied'|'cancelled'|'expired'|'error'|'unknown'|'superseded',deployment_name}`. Only agent ACK makes applied. Scope: new inbound connections to one trap, not machine isolation; existing sessions are not promised disconnected. TTL runs on sensor even offline.
* `GET /api/v1/cases`: CaseView[].
* `POST /api/v1/cases`: `{title:1..120 chars,session_ids:1..20 UUIDs,note:<=4000 chars}` → CaseView, 201.
* `POST /api/v1/cases/{id}`: `{revision,status:'new'|'investigating'|'closed',note:<=4000 chars}` → CaseView. CaseView `{id,created_at,title,session_ids,note,status,revision,created_by,updated_at}`. All changes audited.
* `GET /api/v1/sessions/{id}/report`: `{format:'honeyforge-session-report-v1',generated_at,session:SessionView,profile_version:VersionView,deployment:DeploymentView,events:EventView[],findings:FindingView[],source_blocks:SourceBlockView[],audit:AuditView[],total,truncated,collection:{host_status,metrics,watermark},limitations:string[],sha256}`. Up to 5000 events. Printable UI report with exact evidence IDs, clear observed vs intent, no claims about client OS. Hash is canonical JSON of actual response without sha256 (sorted keys, compact, UTF-8, UTC Z).

## Frontend scope

1. Session player: LIVE / pause / catch-up / replay, x1 x2 x4, seek slider, evidence markers and selected finding. Plaintext command/event stream, bounded rendering, collection/reconnect/truncation visible. New Cowrie runtimes capture real bounded ssh.output alongside commands; older histories honestly report absent output. shell-output sensor.error indicates capture quota/truncation. Pause freezes view only, not ingestion. Replay and live have explicit labels.
2. Overview real source → trap → host topology with click-through and recent sessions, honest offline/severity and bounded transient highlights. Preserve existing metrics and deployment navigation.
3. Source block form and list in session / trap details: reason, TTL, exact scope, pending/applied/unknown/error, cancel. No fake success toast before ACK. Poll fallback when SSE unavailable.
4. Cases UI (can be same session investigation workspace + cases route) and report route with print/PDF via browser. Version, timeline, evidence, operator audit, collection limitations. Add navigation only where it improves use.
5. Use existing design system, React Query, LiveProvider; Mobbin references in docs/PRODUCT_CONCEPT.md (Sentry player, Cloudflare resource graph). Do not rework constructor or start a second frontend server. Regenerate types once root publishes OpenAPI. Build, meaningful player tests, browser acceptance with real API. Never log credentials.

If a contract must change, update this document explicitly before adapting clients. Backend will expose these routes and apply migrations before final acceptance.
