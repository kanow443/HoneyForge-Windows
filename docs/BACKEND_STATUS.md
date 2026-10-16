# Backend: проверенное состояние

Дополнение 11 октября 2026: FR-C1 реализован в schema v3 (2–8 сервисов/портов,
атомарные группы, реальный HTTP/SSH/Low runtime). Оригинальные City/ASN DB-IP release
2026-10 подключены. Beacon padding, протокольные задержки и pre-request SPKI pinning
проверены. Миграция 013, 82 backend tests. Доказательства: multiservice.json,
geo-connected.json, masking-extension.json, pinning-live.json. Интерфейс групп/High:
139 tests и реальные браузерные сценарии 390/1280. High real-OS/reset/egress прошли на двух SSH-транспортах (TCG); high-real-os.json.

Ниже — сохранённый исторический результат исходного выпуска; более поздние проверки
не подменяют условия его нагрузочного эксперимента.

Лабораторный снимок 10 октября 2026, API 127.0.0.1:8100, миграция 012, packages/contracts/openapi.json.
Модульный монолит/PostgreSQL/SSE, два Ubuntu-сенсора, asset-sync, три адаптера. Нейросетей нет.

| Область | Реализация и проверка | Доказательство |
|---|---|---|
| Profiles | v1/hash без изменений, v2, metadata/archive/restore/delete только без истории | test_profiles_v2.py |
| Low | Banner/fixed response/2 KiB / 10 сек/connect/request/disconnect | foundation.json |
| Medium | HTTP accounts/Cowrie shell/commands/output/точные credentials | foundation.json |
| Secrets | AES-GCM/RSA-OAEP до Docker stdout/outbox, scope event/run/session, no-store/audit/RBAC | test_private_capture.py; foundation.json |
| Files | Реальный SFTP/hash, resumable scoped transport, fixture wget/curl без Internet | foundation.json; binary-evidence.json |
| PCAP | Ethernet/IPv4/IPv6 bytes trap bridges, bounded segments/drop metadata | binary-evidence.json; test_evidence.py |
| Retention | events/artifacts 7 д / audit 30 д, pins, receiving excluded, resumable purging, storage 503 | test_retention.py; test_storage_failure.py |
| Channel | Настоящий HTTPS/name/CA, neutral prefix, internal/docs закрыты | foundation.json; masking.json |
| Network | Management10.88.0.1/30/gateway-only namespace, explicit decoy IP, egress deny | masking.json |
| Offline | 60сек, очередь,12маркированных событий без дублей, автономный TTL | live-lab.json |
| Response | NEW IPv4 deny конкретной ловушки, реальный SSH transport termination, ACK | session-termination.json |
| Roles/integrations | 4roles, hashed/scoped/revocable keys, ECS pull/receiver/scoped response | test_roles.py; integrations.json |
| Restore | Независимые DB+binary volume+capture key, event/file/hash/decryption | backup-restore.json |

Evidence: docs/evidence/backend. 63 backend tests и Ruff проходят. Браузерные сценарии:
[FRONTEND_STATUS.md](FRONTEND_STATUS.md): 124 проверки и реальная приёмка четырёх ролей,
основных и бонусных экранов при 390/1280 px. Финальный длительный DOM-прогон завершён на замороженной production build.

Structured credentials/payload шифруются на приманке. Бинарный PCAP содержит реальные
пакеты и может включать открытые HTTP-данные: приватный артефакт с audited доступом
исследующим ролям и защищёнными файлами/backup. Шифрование всего binary evidence не заявляется.
SSH PCAP не раскрывает SSH payload; shell output пишет Cowrie отдельно.

IP не доказывает личность. Client version — заявление, uname относится к эмулятору.
Реакция ограничивает конкретную ловушку/SSH-сессии, не всю машину. High требует выделенного Linux/QEMU-хоста, KVM предпочтителен, TCG выбирается явно.
Локальная нагрузка не является внешним SLA. Исторические evidence сохраняют дату/условия;
старые ограничения заменяются только при новой проверке.


Повторная приёмка ядра: run17bb2a93f02c, 9000 HTTP-взаимодействий /9000 уникальных
событий /0 дублей за900сек при10/сек,8SSH сохранялись весь прогон. Ingest p95=0.8271сек
от observed_at до Event.created_at, без SQL commit/browser. Первый failed run сохранён:
в upstream Cowrie сессии закрывались через300сек, дляv2 установлен предел1800сек.
Браузерная задержка измеряется отдельно по видимым DOM/layout строкам, не paint.

Дополнительные сервисы: honeytokens, observation-time detection policy, CSV/STIX 2.1
Observed Data, offline Geo/ASN и individual mTLS. Код/fixtures: test_bonus.py.
Настоящие HTTP URL/SSH marker/persona: bonuses.json. Individual certificates и реальное
истечение 300s overlap: certificates.json; недоверенный TLS клиент: client-tls.json.
Backup schema012 проверяет также восстановление client CA и новую mTLS issuance
через независимый gateway. В историческом прогоне production MMDB отсутствовали; актуальное подключение описано выше.

Финальный release-прогон: run60f741e923a8, 9000/9000 HTTP events, 0 дублей,
8 authenticated SSH все 900 секунд. Ingest p95=0.8315сек (до Event.created_at).
Браузер: 8078 paired visible DOM/layout rows, p95=1.401сек, min218ms/max3392ms;
0 negative delay/API/parse errors. 922 события приняты API, но не попали в ограниченную
видимую область таблицы. Это p95 показанных строк, не обещание показа каждого события
и не измерение физического paint. Raw samples/checkpoints и unseen_paths сохранены.

После длительного замера исправлена гонка finding-before-event в UI SessionPlayer;
124 frontend regressions и новая сборка PASS. Journal/reporter не изменялись, однако
900s DOM-метрика относится к build816bb3d2, а не к последующему build7ff8311a.
Final frontend assets проверяются независимо scripts/verify-production-frontend.py.
