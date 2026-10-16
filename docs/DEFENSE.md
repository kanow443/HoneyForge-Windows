# HoneyForge: защита и ответы

> Для текущей защиты используйте [HoneyForge-Windows-defense-guide.md](../deliverables/HoneyForge-Windows-defense-guide.md) и [HoneyForge-Windows-defense-v4.pptx](../deliverables/HoneyForge-Windows-defense-v4.pptx). Сценарий ниже относится к прежней сборке. Текущий проект поддерживает Low и Medium; поддержку High и локальную историю удалили.

## Три минуты: живое демо

Перед началом открыть панель «Сеть ловушек» и терминал клиента. Две отдельные Ubuntu
sensor VM уже зарегистрированы по HTTPS. Использовать специально выделенную демо-ловушку,
чтобы реакция не закрыла сессии нагрузочной проверки. Рабочие адреса брать из панели,
а не из устаревшего текста. Проверить clock, generation и статус online/running.

| Время | Действие | Что видит жюри | Что объяснить |
|---|---|---|---|
| 0:00–0:20 | Открыть схему сети, подключиться к TCP Low | Реальная активность узла и bytes Low | Low возвращает баннер и не имеет shell/auth |
| 0:20–0:45 | Показать опубликованный профиль v2 | Версия, hash, баннер, decoy accounts/files | Публикация не изменяет действующие ловушки |
| 0:45–1:25 | Открыть SSH Medium, ввести hostname/ls/cat | Команды и вывод в живом плеере | Cowrie эмулирует сервис, агент доставляет реальные наблюдения |
| 1:25–1:55 | Передать безопасный файл SFTP, открыть evidence | Размер, session/run, SHA-256 и download | Скачивание доступно после подтверждения bytes/hash |
| 1:55–2:20 | Создать реакцию для наблюдаемого IP и ловушки | Pending становится подтверждённым после ACK | Блок ограничен ловушкой/TTL, активный SSH закрывается отдельно |
| 2:20–2:40 | Показать закрытый транспорт и сохранённую сессию | История доступна после реакции | Реакция не удаляет доказательства |
| 2:40–3:00 | Показать таблицу реальных проверок и архитектуру | TLS/outbox/restore/roles/нагрузка | Каждому утверждению соответствует proof |

Исходный пароль не раскрывать на проекторе без необходимости. Действие private reveal
создаёт аудит, требует разрешённой роли и не попадает в экспорт/общий кеш. Демо-клиент
использует только фиктивные сервисные аккаунты. Управляющие ключи не показывать.

Два полных прогона и видео фиксируются отдельно в frontend evidence. Резервное видео
является записью реального эксперимента и подписывается записью. Старые события плеер
подписывает историей. Не рассказывать о live по скриншоту или воспроизведению истории.

## Архитектурные решения для вопросов

| Вопрос / проблема | Выбор и причина | Проверка | Граница |
|---|---|---|---|
| Почему монолит? | Одна согласованная транзакция для команд, аудита и stream, меньше эксплуатации | UoW regression | Масштабирование только по измерениям |
| Почему PostgreSQL? | FK, unique ID, JSONB, history и commit before ACK | Dedupe/restore tests | Не заявляем бесконечный объём |
| Почему SSE? | Односторонние изменения UI, команды HTTP, replay с cursor | Reconnect / real browser | Browser DOM/layout latency не равна paint |
| Почему immutable profile? | Не менять незаметно running runtime | v1/hash/v2/redeploy tests | Образ также фиксируется digest конкретного run |
| Почему adapter allowlist? | Конфиг не даёт произвольный shell/Docker параметр | Invalid profile + isolation probes | Новые протоколы требуют адаптера и приёмки |
| Где агент? | Снаружи контейнера, systemd на доверенном сенсоре | Masking: mounts/processes/files | Root host compromise вне модели |
| Как работает masking? | Строгий TLS, неприметный path, separate route, neutral name | Bad CA/route/network probes | Абсолютную нераспознаваемость не гарантируем |
| Как защищён пароль? | Fresh AES-GCM record key, RSA-OAEP, AAD scope до stdout | Wrong AAD/tag/replay + actual HTTP/SSH | Сырые HTTP-пакеты PCAP могут содержать plaintext |
| Что при outage? | Durable SQLite outbox, retry, ACK after commit | 60s real outage/restart/no duplicates | Квоты/диск ограничивают сбор, потери видимы |
| Это exactly once? | At least once delivery + idempotent storage | Same event ID replay | После retention событие уже не хранится |
| Случайно удалите evidence? | Pins, receiving excluded, purging recovery, race409 | Retention and ENOSPC | Pin не восстанавливает уже expired bytes |
| Можно скачать malware? | Real SFTP и строгий лабораторный fixture | Hash/bytes/download | Свободный Internet не открыт |
| Как закрываете SSH? | Приватный локальный transport registry + ACK IDs | session-termination.json | Только текущий scoped runtime, не вся машина |
| Что определяет IP? | Наблюдаемый адрес в данной сети | Источник другого sensor VM | NAT/proxy/подмена не доказывают личность |
| ОС атакующего? | Баннер клиента и наблюдения имеют provenance | Event client.version/kex | ОС эмулятора не является ОС посетителя |
| Что ваше поверх Cowrie? | Control plane, Low/HTTP, profiles, crypto/outbox/evidence/reaction/UI | Исходники и acceptance | SSH/SFTP и shell принадлежат Cowrie |
| Где High? | Отдельный KVM backend pool, внешний network policy/reset | Capability probe | Без подходящего host функция unavailable |
| Multi-tenant? | Независимые установки с разными БД/ключами/CA | Isolated restore | Нет shared multi-tenant обещания |
| Какой SLA? | Только фактический local benchmark | Environment/rate/duration proof | Целевой внешний SLA требует external deployment |
| Почему 8 SSH закрылись? | Pinned Cowrie default max300s, исправили v2 до bounded1800s | Failed run сохранён и повтор900s | Квоты и время имеют явные пределы |

## Собственный вклад и происхождение

Сторонние компоненты и версии перечислены в THIRD_PARTY.json/THIRD_PARTY.md.
Cowrie обеспечивает протокол и эмулятор. Собственная работа: TCP/HTTP сенсоры,
profile lifecycle, remote jobs/reconcile, scope/dedupe/encryption, PCAP/file transport,
case retention, реакции, explainable rules и реальный интерфейс.

Критерии из полного ТЗ: работоспособность, полнота/глубина, маскировка, зрелость,
качество защиты. Состав жюри, веса и дополнительные правила неизвестны. Соответствие
требованиям подтверждается REQUIREMENTS.md. Победа не является обещанием продукта.

## Дополнительные готовые ответы

| Вопрос | Решение / доказательство / граница |
|---|---|
| Honeytokens реально работают? | Уникальные scoped bindings: actual URL GET и SSH output в bonuses.json. Отзыв немедленно запрещает атрибуцию; старый файл исчезает после явного redeploy. |
| Это прогноз атаки? | Детерминированный порог наблюдаемых входов в фиксированном временном окне; поздние события сохраняются как history, не создают новый LIVE всплеск. |
| Почему Observed Data, а не Indicators? | Экспорт сообщает наблюдения с event/run/provenance, не объявляет каждую увиденную сущность вредоносной. STIX проверен независимым parser. |
| GeoIP где? | Локальные лицензированные City/ASN MMDB подключаются оператором. Частные IP и отсутствие базы явно недоступны; тестовые базы не выдаются за production. |
| Как отзывается сенсор? | Individual client CA + host-bound SHA, two-phase rotation/300s overlap, revoke. Реальные два сенсора и неправильный TLS client проверены. |
| Как измерена скорость? | Final900s:9000/9000,0duplicates,8SSH. p95DOM=1.401s по8078 видимым строкам;922 приняты, не показаны в viewport. Paint и внешний SLA не измерены. |
