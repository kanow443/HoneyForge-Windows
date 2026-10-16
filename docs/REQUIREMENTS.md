# HoneyForge: требования и приёмка

Источник: полное ТЗ «Мадригал. Конструктор», 6 страниц, получено 10 октября 2026.
Реализация выполняется по T01–T24. Статус «код» не означает пройденную живую приёмку.

## Границы доверия

Центр хранит БД, аудит, ключи расшифровки и панель. Доверенный sensor host управляет
Docker/iptables и локальным outbox. Недоверенная среда приманки — отдельный контейнер
Low/Medium либо отдельный гостевой VM для High. Атакующему доступны только приманочные
сервисы. Docker socket, операторские cookies, приватные ключи и management-сеть в приманку
не передаются. Агент работает снаружи этой среды. Захват сенсора/гипервизора root-пользователем
выходит за эту модель; нейтральное имя службы само по себе не предотвращает обнаружение.

## Матрица

| Требование | Задачи / реализация | Сценарий приёмки | Evidence / состояние |
|---|---|---|---|
| FR-C1 Must | Версии v1/v2 неизменны; bundle v3 с 2–8 сервисами/портами, атомарные группы | Реальная группа HTTP/SSH/Low, общие запуск/stop/redeploy, конфликты и совместимость | multiservice.json; test_multiservice.py; frontend/multiservice-browser.json |
| FR-C2 Must | Enrollment, heartbeat, deployments | online/offline/revoked, профиль/host/run | foundation.json; masking.json; live-lab.json |
| FR-C3 Must | T08/T09 TLS, конфиг/telemetry | реальный HTTPS агент, неверный сертификат | foundation.json; masking.json |
| FR-C4 Must | PostgreSQL, фильтры, история | host/trap/time/source/type + reconnect | тесты backend; live-lab.json |
| FR-C5 Must | Login/CSRF/RBAC | четыре роли, прямые запрещённые API | test_roles; frontend/browser-acceptance.json: four actual roles |
| FR-C6 Bonus | Agent jobs/leases/reconcile | кнопка запуска, readiness, ACK | live-lab.json |
| FR-C7 Bonus | T17 rules/CSV/STIX | late events, threshold, export provenance | test_bonus.py; bonuses.json; independent stix2 parse |
| FR-A1 Must | T03 tcp-banner Low; HTTP/Cowrie Medium | сканирование + SSH команды | foundation.json; test_profiles_v2.py |
| FR-A2 Must | T05 credentials/payload; commands/network | шифрование до логов; чтение по роли | foundation.json; test_private_capture.py |
| FR-A3 Must | Pull agent, T19 beacon | новый конфиг, события, интервалы | live-lab.json; certificates.json: actual delivered heartbeat intervals |
| FR-A4 Must | SQLite outbox + dedupe | 60s outage, restart, drain/no dupes | live-lab.json: HTTPS/60s/restart/dedupe |
| FR-A5 Bonus | Наш QEMU pool + Cowrie proxy, VM/overlay на SSH-транспорт | Реальная Ubuntu, процессы, файл, повторный вход, egress deny | high-real-os.json + high-files.json: real OS/reset/egress/SFTP/playback; KVM default, TCG явно |
| FR-A6 Bonus | T16 honeytokens | выпуск → обращение → finding → отзыв | bonuses.json: actual URL/file; test_bonus.py scope/retry/revoke |
| MASK-1 Must | T08 TLS | сертификат/name validation, encrypted traffic | foundation.json; masking.json |
| MASK-2 Must | T09 gateway alias | обычный root, /agent/docs unavailable | masking.json |
| MASK-3 Must | T10 mgmt/decoy routes | trap cannot reach mgmt/host/neighbor | masking.json: 2 sensors / 10 traps / gateway-only route |
| MASK-4 Must | T11 external neutral service | процессы/файлы/сокеты из приманки | masking.json |
| MASK-5 Bonus | Jitter beacon + случайное padding 128–1024 байта; независимые события | Вариация доставленных интервалов и outbound TLS application record размеров | masking-extension.json; certificates.json |
| MASK-6 Bonus | Persona, баннеры, nginx-like errors, bounded HTTP/Low/SSH auth delays | Реальные HTTP/Low/SSH пробы; данные и длительность ответов | masking-extension.json; bonuses.json; универсальное скрытие от детекторов не заявляется |
| MASK-7 Bonus | CA/name + pre-request SPKI pinning, mTLS/rotation | Pin mismatch до HTTP/credentials, перекрытие двух pins; client grace/revoke/queue | pinning-live.json; test_tls_pinning.py; certificates.json; client-tls.json |

## Дополнение от 11 октября 2026

FR-C1 закрыт единым профилем v3 и реальным многосервисным runtime. Все дочерние ловушки
связаны с одной неизменной версией; конфигурация и порты передаются сенсору. API атомарно
резервирует порты/задания, наблюдаемое состояние подтверждает агент. История v1/v2 сохранена.

Раздел 7.3: обе оригинальные DB-IP Lite MMDB release 2026-10 подключены в работающем API.
Контрольные суммы издателя проверены; публичные IP получают City/ASN, private IP явно
недоступны. Metadata/дата/провайдер видны; замену повреждённой базой блокирует updater.
Доказательство: geo-connected.json, test_geo_update.py, windows-geo-extension.json.

MASK-5/6/7 дополнены размерами, задержками и SPKI pinning. Пробы проверяют заданные
поверхности протокола, а не гарантированную нераспознаваемость всеми средствами анализа.
Неверный pin отвергается до первого HTTP запроса; доверие CA/имени остаётся обязательным.

High — бонус с настоящей Ubuntu на доверенном Linux-сенсоре. KVM предпочтителен; явно
выбранный TCG запускает настоящую ОС программно. Длительный прогон нового High ещё
не включён в старые нагрузочные результаты. Два отдельных транспорта и reset проверены (high-real-os.json); инструкции: HIGH_RUNTIME.md.

Исторические JSON сохраняют даты и условия. Windows scripts проверены PowerShell 7 и
реальными Linux containers; Windows 11/PowerShell 5.1/ACL/гипервизор на целевом ПК ещё
требуют отдельного запуска. Проверка локального стенда не является внешним SLA.

Текущая приёмка расширений и SHA-256 доказательств: [pdf-extension-release.json](evidence/pdf-extension-release.json). `release.json` сохраняет исторический выпуск 10 октября и его нагрузочные измерения.

## Дополнение Uni: роли и флаги

Роль `participant` изолирована от операторских данных: только перечень CTF-заданий, отправка флага, таблица результатов и собственная сессия. Задание привязано к активному honeytoken binding конкретного поколения ловушки. Флаг `HF{...}` размещается в приманочном ресурсе при следующем применении профиля, решение учитывается один раз на участника и задание. Отзыв honeytoken, отключение задания и смена поколения прекращают новый зачёт. У события есть отдельные ручные пометки аналитика (`suspicious`, `reviewed`, `false_positive`, `escalated`) с аудитом; исходное событие остаётся неизменным.

Это расширение **не является требованием исходного PDF**. Код и доступы покрыты `tests/test_flags.py`; миграция `014_flags.py`. Исторические нагрузочные evidence не подтверждают производительность нового функционала. Подробное объяснение: `deliverables/Uni-HoneyForge-project-guide.md`.
