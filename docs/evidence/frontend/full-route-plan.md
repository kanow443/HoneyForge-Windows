# Final all-route browser coverage plan

Prepared during frozen900s run60f741e923a8. This is a plan, not executed acceptance. No app/script/source/dist/runtime changes occur during the load. After root releases the freeze, implement/run one isolated real Chromium script against the final production preview5174; current dynamic IDs are read from real APIs, not guessed. Check both1280×900 and390×844. All screenshots must show loaded data or a genuine empty/unavailable state, never an unfinished loading screen.

| Principal screen or section | Actual route/flow | Required evidence |
| --- | --- | --- |
| Overview/topology and findings | / | Actual overview/topology/findings200, “Сеть ловушек”, loaded topology/list; findings are a section here, not a separate /findings route |
| Profiles register | /profiles | Real profiles200, table or genuine empty state, loaded rows |
| Profile detail/version/markers | /profiles/{actualID} | Profile200, actual selected version/metadata, collapsed/loaded markers; no issue/revoke in this route smoke |
| Low builder | /profiles/new?adapter=tcp-banner | Loaded service fields and local preview, no HTTP/files/auth claim, no publication |
| HTTP builder | /profiles/new?adapter=http | Loaded template/preview; local field changes may be discarded, no publication |
| SSH builder/files | /profiles/new?adapter=cowrie | Loaded service, file editor and local preview; no publication/network client |
| Existing version editor | /profiles/{actualID}/edit | Real immutable version draft loaded, no publication |
| Hosts register/detail/certificates | /hosts?host={actualID} | Hosts200, actual host details; admin certificate section reads200, no revocation/enrollment |
| Trap register | /traps | Deployments200, real states/table |
| Trap detail/jobs/evidence | /traps/{actualID} | Deployment200, loaded actual state/stages/session links/evidence, no start/stop/redeploy |
| New trap form | /traps/new | Real profile/host inputs loaded; no submit/deployment |
| Event journal/inspector/detection settings | /events | Events200 and body/list; select actual sanitized event if available; actual policy200/review optional, no mutation |
| Session list and real player | Trap detail session section then /sessions/{actualID} | Real sessions/session/playback200, actual commands/output or honest absent output, expanded player if needed; no fabricated traffic |
| Case register/detail | /cases?case={actualID} | Cases200, selected actual case/revision or honest empty; no update/pin/unpin |
| Investigation report | /sessions/{actualID}/report | Report200, real counts/limitations/hash state; no print/native PDF claim |
| Integrations | /integrations | Admin list200, real metadata or true empty, optional create-default form cancelled; no key issue/revoke |
| Users | /users | Admin users200, actual table; optional default modal cancelled; no create/role change |
| Storage/settings | /storage and collapsed policy in /events | Storage200, actual quota/retention; there is no separate /settings route |
| Operator audit | /audit | Audit200, actual list or true empty |
| Login and denied navigation | /login unauthenticated; non-admin admin routes already covered by actual role tests | Empty password field, no secret screenshot; redirect/denial honest, no root credentials printed |

For each route record: measured innerWidth/innerHeight/document.scrollWidth; selected API statuses and request completion; no uncaught pageerror; no error panel unless the captured state is an explicit server-unavailable state (then mark failed/unverified, never passed silently); loading disappeared; screenshot path. Tables/code may scroll inside their bounded container while the page itself must not overflow.

No fabricated sessions/cases/markers or fake counters to make an empty screen attractive. Existing read-only case may be closed/pinned; preserve its exact state. Role matrix is independently verified by actual viewer/analyst/operator tests, not inferred from this administrator sweep. Native PDF and an external SIEM remain separate/unverified.

Final live demos after the sweep use only the released Acceptance20184685 namespace at18222/18223, with unique ui-demo names and existing profile markers preserved. Earlier videos are archived under video/pre-bonus. Record two fresh native moving clips, verify real SFTP bytes/hash, actual source-scoped agent termination plus client EOF, cancellation/release ACK and report; full decode, black intervals and distinct motion frames. No action against Operations or Scale load sessions. Root owns final backend/Git/packaging/release proof.
