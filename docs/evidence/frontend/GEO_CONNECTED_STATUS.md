# Connected Geo/ASN frontend verification

Updated 2026-10-11T00:07:04.043335+00:00. Actual browser/API run PASS on the existing built frontend at http://localhost:5173. Original connected DB-IP City and ASN Lite release 2026-10 both Available; provider, age, build timestamps and DB-IP/CC BY4.0 attribution visible at 390 and 1280. Private source `192.168.139.3` remains unavailable with country/city/ASN absent. No public sample IP/events inserted.

`geo-connected-browser.json` stores actual metadata and displayed Russian date/time strings; four viewport measurements show no document overflow. Separate `geo-connected-metadata-1280.png`, `geo-connected-metadata-390.png`, `geo-connected-private-1280.png`, `geo-connected-private-390.png` are real rendered screens; both metadata widths visually inspected. Mobile table is horizontally scrollable, as other product tables are.

`docs/USER_GUIDE_RU.md` updated with sections6.3 (Geo/ASN),9.7 (2–8-service v3 builder),9.8 (separate High capability/proxy readiness/local preview),10.4 (create/status/stop/compatible redeploy group), route/API tables and current Geo availability. Older statement that High only required KVM and was absent removed. TCG first-connection timeout up to600s and KVM default240s stated. Frontend's existing short High notice had no240s ceiling, so no UI code change was needed.

No rebuild: no UI source changes; existing42-file dist matches manifest `9b5bc202a0116c82f4f54351436af7de3145860103fbdb1ea7e1ff40e6f92492` (checked: True). No sensor restart, deployment/response mutations or private-capture access. Only own authentication session created and logged out. Guest-OS verification remains root/backend-owned; this run makes no VM execution claim.
