# HoneyForge: исполнение T01–T24

Исторический снимок 10 октября 2026; актуальное дополнение 11 октября в конце. «Код и тесты» отделены от живой приёмки.
Источник: полное ТЗ «Мадригал. Конструктор.pdf», 6 страниц.

| Задача | Выполнено | Проверка / оставшееся |
|---|---|---|
| T01 | Матрица FR/MASK, три контура доверия | REQUIREMENTS.md, ARCHITECTURE.md |
| T02 | Схема v2, неизменные v1/hash, runtime contract | test_profiles_v2.py, foundation.json |
| T03 | Настоящий TCP Low, HTTP/Cowrie Medium | Foundation: реальные connections/bytes/truncation |
| T04 | Metadata/archive/restore/delete-conflict, роли | Backend tests, frontend lifecycle API/browser |
| T05 | Envelope encryption до stdout/outbox, scoped reveal/audit/no-store | Реальные HTTP/SSH credentials, viewer403, no plaintext |
| T06 | SFTP в pinned Cowrie, SHA-256, resumable delivery | foundation.json, binary-evidence.json |
| T07 | 7d/30d, case pins, resumable cleanup, quota/storage failures | Retention tests, ENOSPC, pin/purging race409 |
| T08 | Строгий HTTPS live agents, CA/hostname | foundation.json, masking.json |
| T09 | Separate gateway /assets/sync/v1, internal rewrite, static root | masking.json |
| T10 | Management namespace + explicit decoy binds, firewall | 2 VM / 10 actual traps, outbound probes |
| T11 | asset-sync, приватные каталоги вне приманок | Process/files/socket/mount checks |
| T12 | Compose, clean Ubuntu installer, independent backup/restore | backup-restore.json schema012, decrypt/hash/client CA |
| T13 | Low/Medium constructor, v2 options, explicit publish/redeploy | Frontend real browser scenarios |
| T14 | Lifecycle, private reveal, pins, storage states | Frontend real roles and API failures |
| T15 | Integration key lifecycle + four roles | Frontend real browser scenarios |
| T16 | URL/file registry, scoped runtime bindings, use finding, revoke | bonuses.json: actual HTTP request and SSH output; test_bonus.py dedupe/scope/delayed delivery |
| T17 | Configurable observed-time windows/current-historical; CSV/STIX 2.1 Observed Data | test_bonus.py late delivery/threshold/disable/revision; independent stix2 parser and real export |
| T18 | Offline City/ASN MMDB, build date, top20 sources | Genuine upstream test MMDB parser check; production bases absent, UI honestly unavailable |
| T19 | Beacon5±20%, independent upload; default Ubuntu persona | Actual delivered intervals certificates.json; banners/kernel/os-release/errors bonuses.json |
| T20 | Individual RSA CSR/client CA, 2-phase rotation, 300s overlap, revoke | Both real sensors mandatory mTLS; client-tls.json wrong CA; certificates.json real elapsed grace; queue rejection/restart tests |
| T21 | High не доступен на текущих VM без /dev/kvm | Основной release не зависит от этого бонуса |
| T22 | 2 sensors/10 traps, HTTP9000 unique/0duplicates, 60s outage, TLS/restore | Final run60f741e923a8:9000/0duplicates/8SSH900s; DOM8078 p95=1.401s;922 вне viewport;52 route checks390/1280PASS |
| T23 | Установка/архитектура/ER/matrix/third-party | Инструкции/screens/ER/matrix/лицензии завершены; independent source config PASS; release codex/honeyforge-release |
| T24 | Редактируемая PPTX8 slides, сценарий/ответы | Два fresh final demo на canonical5173 PASS; реальные video/decode/black-frame/motion PASS; deck: integrity/layout/import PASS, все8 slides просмотрены |

## Дополнение 11 октября 2026

FR-C1: schema v3 / 2–8 сервисов и портов / атомарная группа; старые v1/v2/hash сохранены.
Контракт и API: MULTISERVICE_CONTRACT.md. Live: multiservice.json, frontend/multiservice-browser.json.
T18: реальные оригинальные City/ASN DB-IP October 2026 подключены; geo-connected.json.
T19: случайные размеры beacon и bounded HTTP/Low/auth тайминги; masking-extension.json.
T20: SPKI pin до HTTP, два pins при ротации; pinning-live.json, test_tls_pinning.py.
T21: настоящая Ubuntu 24.04.5 на QEMU TCG / отдельный overlay на SSH-транспорт,
2 последовательных сессии / /root reset / новые исходящие подключения запрещены.
Доказательство: high-real-os.json; KVM live на этой машине не проверялся.
Windows: packaged public Geo / backup v2 / независимый restore Geo + centre,
windows-geo-extension.json. Native Windows/ACL/WSL acceptance остаётся отдельной.
Backend: 82 tests; frontend: 135 tests + новые реальные browser сценарии.
Обновлённые руководство/архитектурные решения/лицензии сохраняют границы старых замеров.
Новые функции не объявляются проверенными прежним 15-минутным benchmark.
