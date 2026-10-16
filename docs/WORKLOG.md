# Журнал работы HoneyForge

Журнал связывает задачу, решение, изменение и доказательство. Он нужен для восстановления хода работы и объяснения проекта на защите. План не считается реализацией, а референс не считается скриншотом собственного интерфейса.

## Запись P01 Подготовка плана

**Дата:** 9 октября 2026 года. **Статус:** подготовлен план; приложение не реализовано. **Основание:** предоставленная карточка и уточнение пользователя: один человек, реализация с помощью ИИ, другой информации о задании нет.

| Действие | Зачем | Результат и артефакт |
| --- | --- | --- |
| Проверено содержимое рабочей папки и применимые инструкции | Установить фактическую исходную точку | Папка проекта была пустой; исходников и существующих документов нет |
| Разобрана карточка задания | Отделить обязательный продуктовый сценарий от предложений реализации | R01–R08 в PRODUCT_PLAN; оригинал сохранён в source |
| Учтён формат работы одного человека с ИИ | Задать последовательные этапы и приёмку | T01–T18 и G1–G4; дедлайн не предполагается известным |
| Проверена актуальная документация Cowrie | Различить shell и proxy, подобрать источник событий | Режимы и ссылки в ARCHITECTURE; medium отделён от high |
| Проверены Docker security, rootless и сетевые ограничения | Определить границу доверия, обязательность теста IP и сети | Выбран отдельный sensor VM, agent как доверенный executor, условия пересмотра rootless |
| Проверены FastAPI SSE и PostgreSQL NOTIFY | Спланировать поток и восстановление без недолговечной очереди | Durable event_stream, commit-safe cursor, polling wake-up для P0 |
| Выполнены три поиска экранов и один поиск flow в Mobbin | Найти паттерны для конкретных операторских сценариев | Vercel, Sentry, Braintrust и Cloudflare; постоянные ссылки в UI_REFERENCES |
| Просмотрены изображения выбранных паттернов, скачаны семь оригинальных референсов | Сохранить визуальные основания без временных URL | references/images и manifest.json |
| Созданы модель архитектуры, реестр решений и порядок реализации | Сделать предложение конкретным и проверяемым | ARCHITECTURE, DECISIONS, DELIVERY_PLAN |
| Подготовлены инструкция работы ИИ и сценарий защиты | Накопить объяснение вместе с дальнейшей реализацией | AI_WORKFLOW, DEFENSE и шаблон записи ниже |
| Проверены локальные ссылки, нумерация задач и требования, JSON-манифест и типы изображений | Исключить сломанные артефакты планирования | Девять Markdown-документов, T01–T18, R01–R08 и семь WEBP-файлов; проверка завершилась PASS |

Проверка этой записи: прочитаны документы, проверены локальные ссылки, сохранённые референсы и согласованность T/R/ADR. Результаты runtime, тестов приложения и измерений производительности отсутствуют; их предстоит получить на T-задачах.

## Шаблон записи реализации

```text
Запись: номер, дата, T-задача
Статус: в работе / реализовано / проверено / ожидает конкретной проверки
Проблема: что требовалось изменить и какой сценарий страдал
Решение: выбранный подход и ADR
Действия:
  - Что изменено; файл/модуль/настройка; зачем
  - Что проверено; точная команда или шаги; expected и actual
  - Как исправлена обнаруженная ошибка и чем подтверждено исправление
Состояние после задачи: какое поведение теперь доступно
Доказательства: docs/evidence/Txx/... и IDs примеров
Версия: commit или snapshot, версии зависимостей/образов
Ограничения: что осталось неизвестным или не прошло
Следующая задача: ID и причина порядка
Фраза для защиты: результат + причина решения + доказательство
```

## Правила достоверности

Писать «реализовано», если код/конфигурация присутствуют; «проверено», если завершена нужная проверка и сохранён результат. Не завершившийся процесс не является pass. Обнаруженное ограничение записывать рядом с результатом. Если доказательство основано на учебном наборе, указывать это явно.

Не заменять первоначальную запись после изменения решения. Добавить новую запись с причиной и ссылкой на прежнюю, затем обновить актуальную архитектуру. Перед защитой использовать окончательное поведение, а историю — только для объяснения значимого компромисса.


## 2026-10-10 — LIVE, расследования и полное руководство

Реализованы backend playback/topology/source-block/case/report API, migration 003, typed OpenAPI, ACK/revision/local TTL, bounded collection and independent collector. Добавлена запись настоящего вывода Cowrie с квотами и provenance. При отозванном старом хосте зарегистрирована новая идентичность без снятия отзыва; подготовлены три синтетических LIVE-профиля/ловушки. Образы закреплены; updated runtime применён явно.

Проверки: 27 backend tests, Ruff и Alembic check; реальный SSH/session-output; 10 commands/s delivery p95 0.736с до SSE-triggered API read (без browser render); scoped firewall, restart, обе семьи сети отключены на 60с, 12 уникальных HTTP-наблюдений восстановлены без дублей и TTL снят автономно. Результат: docs/evidence/backend/live-lab.json. Первые неуспешные latency/IPv4-only попытки исправлены; подробности в BACKEND_STATUS.md.

Фронтенд реализован в ранее разрешённом втором чате: LIVE/replay/seek, карта, ACK-статусы, дела, отчёт/hash. Его итог: 38 тестов и production build, реальные browser journeys; границы мобильного/PDF проверок в FRONTEND_STATUS.md. Backend не изменял apps/web.

По запросу пользователя создан docs/USER_GUIDE_RU.md: 22 раздела, карта всех экранов, кнопок/полей и действий, frontend/backend behavior, общие сведения, локальный запуск, ошибки, полный проход и 3-минутная защита. Сверен с финальными названиями; LOCAL_TOUR заменён актуальным коротким маршрутом, README/DEPLOYMENT/PRODUCT_CONCEPT обновлены ссылками и статусом. Пароли/индивидуальные ключи в документы не скопированы.


## 2026-10-10 — обязательный контур T01–T15

Прочитано полное ТЗ (6 страниц), сохранён source PDF; матрица FR/MASK отделена от прежней
краткой карточки. Зафиксированы центр, trusted sensor и decoy trust boundaries. Добавлены
schema v2 с v1/hash compatibility, Low TCP 2KiB/10s, metadata/archive/restore/delete-conflict,
sealed credentials/payload с fresh AES-GCM/RSA-OAEP/AAD, explicit audited private reveal,
реальный SFTP и resumable SHA delivery. 7d/30d retention исключает pins/receiving и продолжает
purging после interruption; pin после начала purging отвергается409. Actual ENOSPC проверен
на отдельном 64KiB tmpfs без заполнения диска рабочего компьютера; storage503/offets/retry
отдельно покрыты backend tests.

Настоящие агенты используют strict HTTPS/CA/name, gateway assets/sync/v1, gateway-only
management namespace, exact decoy IP and external firewall; neutral systemd service и private
state вне traps. Чистый Ubuntu installer/Compose/independent backup DB+binary+keys проверены.
Фронтенд использует реальные API; роли, profile lifecycle, evidence privacy/pins, integrations
и ошибки проверены в собственном браузере при390/1280. Основной guide дополнен точными
современными кнопками UI_OPERATIONS_V2.md. No artificial telemetry, no LLM runtime.

## 2026-10-10 — устранение ошибки длительных SSH-сессий

Первый900s прогон выявил upstream interactive_timeout300s, несмотря на keepalive commands.
Это общий предел сессии, а не idle timeout. Первый failed proof сохранён. Для v2 предел1800s,
legacyv1 остаётся300s; idle/authentication guards сохраняются. Повтор17bb2a93f02c прошёл:
9000 actual HTTP requests/events,0dupes,8 authenticated SSH active900s. Ingestp95 .8271s
исключает SQL commit/browser. Browser17bb aggregate не заменяет отсутствующую final raw
таблицу после сбоя финализации. Reporter изменён: namedSIGUSR2 registered before ready,
atomic/fsync raw checkpoints и finalization smoke. Финальный повтор измеряется отдельно.

## 2026-10-10 — бонусы T16–T20 и восстановление schema012

Honeytoken registry/bindings/uses поддерживают profileversion+run scope, duplicate safety,
observed-time revocation и explicit redeploy. Actual URL/file output/persona проверены:
bonuses.json; ввод команды без вывода не признаётся использованием. DetectionPolicy имеет
optimistic revision и observation-time fixed windows; historical не создаёт false new alarm.
Собственный exporter CSV/STIX2.1 ObservedData имеет source IDs/provenance и только verified
available file hashes; independent stix2 parser подтверждает формат. Offline Geo/MMDB/date
парсер проверен genuine pinned upstream binary fixtures с Apache license. Production базы
не подменены тестовыми данными, private/missing состояния honest unavailable.

mTLS: private client CA в центре, публичный CA-only mount gateway, индивидуальный RSA CSR
и private keys sensor-side, API host binding/expiry/revoke, gateway header overwrite. Agent
current/pending identities crash resumable; HTTP transport replacement синхронизирован с
requests, collection independent. Реальная двухфазная ротация обоих сенсоров и elapsed300s
old rejection/explicit revoke прошли; wrong fresh self-signed TLS clients отклонены.
Delivered heartbeat intervals отмечают transport/tick overhead отдельно от5±20% schedule.
Certificate rejection не стирает outbox; после подтверждения bootstrap без сертификата
запрещён. Independent restore schema012 вернул данные, decrypt и original client CA;
новая issuance/actual mTLS через восстановленный gateway проверена. Source copied identities
отозваны до backup, target остановлен после проверки. Server TLS Caddy state требует
отдельного сохранения/redistribution private CA, это описано в deployment guide.

Полная backend regression:62 tests, Ruff и Alembic check; OpenAPI совпадает,66 paths.
Frontend:123 tests/27 files, production build и6 bonus real-browser scenarios/roles/390/1280.
Повторены foundation/SFTP/no-plaintext, network boundaries, SSH EOF/source scope, binary
files/PCAP,60s outage/TTL/restart и ECS receiver/response/revoke. Рост реальной истории выявил
недостаточный page budget acceptance receiver; тест читает до1000 страниц по500, без
ограничения функциональности API. CLI receiver дополнительно сообщает has_more/page budget,
чтобы ограниченный poll не выдавался за полную синхронизацию. High capability proof: обе
isolated VM без /dev/kvm; High остаётся недоступным, не fake implementation.

### Финальная длительная приёмка

Run60f741e923a8: 900 секунд,10HTTP/сек,9000unique/0duplicates,8SSH active весь прогон.
Durable DOM observer нормально завершён:8078visible paired rows,p95=1401ms,
922 API paths вне viewport,0 negative/API/parse errors. Не подменяем DOM paint-метрикой.
Предыдущий interrupted reporter и первый failed Cowrie run сохранены с исходными фактами.

### Воспроизводимость финального выпуска

Production API/gateway пересобраны с закреплёнными base digests и final frontend.
Проверен HTTP-01 front-door route: только стандартный challenge path идёт к management;
остальные management HTTP пути404. Публичная ACME issuance без DNS не заявляется.
Два HTTPS центра: cross-install cookies/keys/profile denied, restart recovery3.642s, schema012 restore0.449s.
Повтор backup сначала остановлен исчерпанным Docker address pool старых тестовых сетей;
удалены только собственные disposable restore containers/networks, volumes сохранены.
После очистки independent DB/binary/decrypt/clientCA/mTLS restore PASS (35ea5be6).
Acceptance helper теперь освобождает disposable networks без удаления evidence volumes.
Agent enrollment использует private0600 atomic fsync/rename для credentials; тест disk failure сохраняет предыдущее содержимое.

Окончательная regression после atomic enrollment fix:63 backend tests PASS; Ruff PASS.

Полный финальный browser route sweep:52 checks/390px и1280px, real API/loaded UI, no page overflow, completed/passed.

Final live demo выявил UI race: finding пришёл раньше evidence event. SessionPlayer теперь
отображает явное ожидание; meaningful missing-event regression добавлена.124 frontend tests/build PASS.
Повтор52route sweep на исправленной сборкеPASS. Длительный DOM-run сохраняет прежний
build816bb3d2; новыйbuild7ff8311a не приписывается старому эксперименту.
Gateway A/B пересобраны; все38 static files и trustedHTTPS index совпадают побайтово с
accepted final build7ff8311a. verify-production-frontend.py сохраняет reproducible proof.

После исправления плеера повторный demo был отклонён Origin check: preview127.0.0.1:5174
не совпадал с configured http://localhost:5173. Failed run сохранён; защиту не отключали
и Origin не подменяли. Final static preview переносится на canonical5173 для настоящих UI writes.
Инструкция теперь содержит exactorigin/strictport и productionpreview команду.

Оба final demo на canonicallocalhost5173 PASS:10 stages каждый, actual SFTP/hash,
SSH EOF +agent ACK и release ACK. Final videos50.28s/47.04s, VP9/1280x900/25fps,
full decode/black interval/moving framesPASS. После них обе VM получилиfinalagent source
SHA3703f30c, preservedidentity/outbox/runtime, fresh mTLS heartbeat;10running traps,
queued/dropped events0. Исторический artifact_errors1 первого sensor сохранён.
Setup использует umask077 и private.runtime700 до записи секретов. Source scripts shell syntaxPASS.

Frontend finalready=true,source/dist stable;124tests/52routes/twofinaldemos allPASS.
Проверенный выпуск фиксируется на codex/honeyforge-release, local tag honeyforge-2026.10.10.
Private.env/runtime/outbox/backups/keys/node_modules исключены; configured-secret scan0matches.
