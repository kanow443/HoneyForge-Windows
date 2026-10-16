# Установка и восстановление HoneyForge

Центр: PostgreSQL/FastAPI, operator gateway и отдельный management gateway.
Сенсор: выделенная Ubuntu 24.04, Docker, asset-sync, приватный outbox и asmgmt0.
Две проверенные Ubuntu VM: по 2 CPU / 2 GiB, без общих папок Mac. Для совместной разработки
рекомендуются 4+ CPU / 16 GiB / 15 GiB диска; это запас, не измеренный минимальный порог.
Нейросетей и платных API нет. Интернет нужен для первой установки зависимостей.

## Локальная установка на Mac

Нужны Docker/Compose, OrbStack, Python 3.12+, uv, Node/npm. Команды из корня исходников.
Работающие экземпляры повторно не запускайте. Новые VM могут иметь другие IP.

1. Подготовить приватные credentials и БД:

~~~sh
./scripts/setup.sh
~~~

2. В отдельном терминале центр:

~~~sh
uv run uvicorn honeyforge.api.main:app --host 127.0.0.1 --port 8100 --reload --reload-dir src --timeout-graceful-shutdown 2
~~~

3. Management HTTPS gateway и публичный CA:

~~~sh
docker compose --env-file .env -p hf-management-local -f compose.management-local.yml up -d
mkdir -p .runtime/tls
docker cp hf-management-local-management-1:/data/caddy/pki/authorities/local/root.crt .runtime/tls/management-ca.crt
~~~

Первый сертификат появляется через несколько секунд. Дождитесь CA, не отключайте TLS.
Ключ CA остаётся в gateway volume; агент проверяет цепочку и имя host.orb.internal.

4. Образы трёх разрешённых адаптеров:

~~~sh
docker build -f infra/Dockerfile.http -t honeyforge-http:0.1.0 .
docker build -f infra/Dockerfile.cowrie -t honeyforge-cowrie:0.1.0 .
docker build -f infra/Dockerfile.tcp -t honeyforge-tcp:0.1.0 .
~~~

5. Изолированный сенсор и чистый Ubuntu installer:

~~~sh
/Applications/OrbStack.app/Contents/MacOS/bin/orbctl create --isolated --cpus 2 --memory 2G ubuntu:noble honeyforge-sensor
uv run python scripts/provision-lab.py --install
~~~

Второй сенсор:

~~~sh
/Applications/OrbStack.app/Contents/MacOS/bin/orbctl create --isolated --cpus 2 --memory 2G ubuntu:noble honeyforge-sensor-2
uv run python scripts/provision-lab.py --vm honeyforge-sensor-2 --install
~~~

Передаются исходники без .env, ключей центра и файлов Mac. Устанавливаются зависимости,
образы, firewall/network/systemd; копируется публичный CA и используется одноразовый token.
Ключ сенсора остаётся в /var/lib/asset-sync/credentials.json, режим 0600.
После регистрации служба создаёт RSA-ключ и CSR в client-identities, получает индивидуальный
сертификат через проверенный HTTPS и подтверждает его отдельным TLS-соединением.
Центр требует сертификат для всех дальнейших действий агента; один Bearer недостаточен.
Повторный provision обновляет сенсор, сохраняя identity/outbox/history.
--reenroll — явное действие после отзыва: старое приватное состояние архивируется, старый
хост остаётся отозванным. Новая identity не восстанавливает старую.

6. Панель в отдельном терминале:

~~~sh
cd apps/web
npm ci
npm run dev
~~~

Для защиты использовать собранный интерфейс на том же разрешённом адресе. Остановить
свой dev-процесс, затем из `apps/web`:

~~~sh
npm run build
npm run preview -- --host 127.0.0.1 --port 5173 --strictPort
~~~

Открывать **http://localhost:5173**, как указано в `HF_PUBLIC_ORIGIN` центра. `localhost`
и `127.0.0.1`, а также разные порты — разные Origin. При смене публичного адреса менять
`HF_PUBLIC_ORIGIN` и перезапускать API; защиту CSRF/Origin не отключать. Preview5174
использовался для чтения при нагрузочном замере, не для интерактивного демо с записью.

7. Подготовить demo:

~~~sh
uv run python scripts/prepare-demo.py --upgrade --refresh
~~~

--upgrade публикует v2 без изменения v1/hash. --refresh создаёт новые runtime generations.
Endpoints: .runtime/demo.json. Операторские credentials: .runtime/access.txt, не показывать
на защите. Учебный SSH: root / hackathon-demo, это синтетическая учётная запись ловушки.

## Текущий проверенный стенд

| Компонент | Адрес |
|---|---|
| UI | http://localhost:5173 |
| Development API | http://127.0.0.1:8100 |
| Настоящие агенты | https://host.orb.internal:18443/assets/sync/v1 |
| Sensor1 / Sensor2 | 192.168.139.142 / 192.168.139.223 |
| Low TCP | 192.168.139.142:2223 |
| Medium SSH | 192.168.139.142:2222 |
| Medium HTTP / vault | 192.168.139.142:18080 / :18081 |

Нативный API/Vite — разработка; реальные агенты даже здесь используют HTTPS.
HF_ALLOW_INSECURE_AGENT=true — только явно выбранная разработка. Агент не публикует HTTP-server.

## Центр через Compose

~~~sh
uv run python scripts/production-env.py --domain console.example.org --management-domain sync.example.org --output .runtime/production.env
docker compose --env-file .runtime/production.env -p honeyforge -f compose.production.yml up -d --build --wait
~~~

Каждый независимый центр получает новый приватный env. DNS обоих имён должен указывать
на соответствующие интерфейсы. Operator80/443, management18443; для отдельного IP/443
задать --management-port 443 и HF_MANAGEMENT_BIND. Внешние сертификаты должны быть
действительными: HF_MANAGEMENT_TLS задаёт email ACME. internal — только доверенный
частный CA. Генератор --loopback поддерживает локальную HTTPS-приёмку.
Если gateways используют один публичный IP, operator gateway на80 передаёт только
/.well-known/acme-challenge/* для management hostname в management:80. Поэтому
публичный80 должен быть доступен для HTTP-01; все остальные management HTTP пути404.
HTTPS management остаётся на выделенном18443 (или отдельном интерфейсе443). Для
закрытого внешнего80 использовать заранее действительный сертификат/проверенный ACME
DNS issuer, а не отключать TLS verification. Реальное получение публичного сертификата
на домене без предоставленного DNS в локальной приёмке не заявляется.

PG/API не публикуют порты. Operator закрывает /agent/* /docs /redoc /openapi.json.
Management root — статическая страница; разрешён /assets/sync/v1/*, переписанный в
/agent/v1/* внутри Caddy route с сохранением порядка URI/rewrite.

## Ubuntu sensor

Исходники извлечь в /opt/asset-sync; на выделенной Ubuntu 24.04:

~~~sh
sudo /opt/asset-sync/scripts/install-sensor.sh https://sync.example.org:18443 10.20.0.10
~~~

Второй аргумент — decoy interface IP; портам запрещено wildcard0.0.0.0.
Для частного CA скопировать публичный сертификат в /etc/asset-sync/management-ca.crt
и задать HF_AGENT_CA_FILE в приватном /etc/asset-sync/agent.env. Для публичного TLS
поле пустое, используется системное доверие.

Management asmgmt0:10.88.0.1/30, отдельный namespace допускает только IPv4/HTTPS gateway.
10.88.0.0/30 и10.89.0.0/30 зарезервированы и не должны пересекаться с сетью организации.
Физический management NIC может заменить логическую сеть после собственной проверки.
Контейнеры не выходят в management/host/neighbors/Internet. При смене gateway IP остановить
агент, перезапустить asset-network.service и повторить сетевые проверки.

Создать token в «Хосты», перенести как файл0600:

~~~sh
sudo /opt/asset-sync/.venv/bin/python /opt/asset-sync/scripts/pin-sensor-server.py
sudo /opt/asset-sync/.venv/bin/python /opt/asset-sync/scripts/enroll-sensor.py --token-file /etc/asset-sync/enrollment.token
sudo systemctl enable --now asset-sync.service
~~~

Token не попадает в argv и удаляется после регистрации. Частный CA установить до запуска агента.

## Согласованные backup/restore

~~~sh
uv run python scripts/backup-production.py --env-file .runtime/production.env --project honeyforge --output .runtime/backups/release-01
~~~

API останавливается на время согласованного PG dump + volume с файлами и приватными
ключами расшифровки, затем запускается с ожиданием ready. Manifest содержит SHA-256,
размеры и фактическую миграцию. Backup приватный: ключи и потенциально чувствительные PCAP.
Deployment env сохранять отдельно. Поднять новый пустой центр:

~~~sh
uv run python scripts/restore-production.py --env-file .runtime/restore.env --project honeyforge-restore --backup .runtime/backups/release-01
~~~

Restore отказывает при существующих прикладных данных, проверяет хеши/пути, запускает API
только после восстановления DB+volume; файлы/ключи принадлежат uid10001. При ошибке target
остаётся offline. Копированные identities нельзя одновременно использовать с исходным
центром без отзыва/ротации. Реальные событие/файл/расшифровка после независимого restore:
[backup-restore.json](evidence/backend/backup-restore.json).

## Приёмка

~~~sh
uv run pytest -q
uv run ruff check src tests scripts infra/migrations
uv run python scripts/verify-foundation.py
uv run python scripts/verify-mask.py
uv run python scripts/verify-live-lab.py --offline
uv run python scripts/verify-session-termination.py
uv run python scripts/verify-evidence.py
~~~

Живые проверки последовательны; некоторые явно переразвёртывают LIVE SSH.
Нагрузка: verify-scale.py --duration 900 --rate 10; DOM отдельно apps/web/scripts/browser.
Неверный сертификат исправить CA/именем, не отключением проверки. Offline сохраняет очередь;
unknown не считается running. Квоты/ошибки записи явные, принятые доказательства не
перезаписываются. Внешний SLA требует настоящего размещения.

## Сертификаты и дополнительные данные

Сертификат агента живёт 24 часа. Служба начинает обновление при остатке меньше 6 часов.
Новый ключ сначала сохраняется с CSR, затем подтверждается через новый TLS-клиент; только
после подтверждения старому остаётся 300 секунд. Незавершённая ротация продолжается после
рестарта с тем же приватным ключом. Для явной ротации на сенсоре:

~~~sh
sudo /opt/asset-sync/.venv/bin/asset-sync rotate-certificate
~~~

Команда ставит приватный запрос; служба обрабатывает его не позднее следующей минутной
проверки. Отзыв сертификата выполняет admin в карточке хоста. Если все сертификаты
отозваны или истекли, автоматический bootstrap запрещён: нужна новая регистрация оператора.
Старая очередь остаётся в приватном состоянии; её нельзя пересылать от имени чужого хоста.
Ошибка сертификата не означает отзыв Bearer-identity и не стирает доказательства.

HF_SYNC_PROXY_SECRET — отдельный случайный секрет API/gateway; генерируется установщиком,
в контейнеры приманок не передаётся. Caddy проверяет цепочку client CA и перезаписывает
служебные заголовки. API проверяет привязку сертификата к identity, expiry, overlap и отзыв.
Режим verify_if_given нужен только для одноразовой регистрации и первоначального CSR;
прочие agent API требуют сертификат. Приватный client CA входит в согласованный backup,
публичная копия gateway восстанавливается при старте API; management затем перезапускается.
Для частного server CA отдельного восстановленного gateway заново распространить его
публичный корень или сохранить защищённый Caddy volume; основной backup его не включает.

Geo/ASN читается локально: HF_GEO_CITY_DB и HF_GEO_ASN_DB задают пути City/ASN MMDB.
Для Compose смонтировать каталог баз только для чтения в API и задать пути внутри него.
Готовый override: `compose.geo.yml`. Добавить в приватный deployment env
`HF_GEO_DIRECTORY=/absolute/path/to/mmdb`, при необходимости
`HF_GEO_CITY_FILENAME=dbip-city-lite.mmdb` и `HF_GEO_ASN_FILENAME=dbip-asn-lite.mmdb`.
Каталог должен уже существовать; процесс API UID10001 должен иметь право чтения файлов
и прохода по каталогам. Запускать с обоими файлами:

```bash
docker compose --env-file .runtime/production.env -p honeyforge \
  -f compose.production.yml -f compose.geo.yml up -d --build --wait
```

В панели «Сеть ловушек» раскрыть «География источников»: там показываются наличие,
тип и дата каждой базы, затем реальные публичные источники. Обновлять MMDB заменой
файла целиком: reader отслеживает inode/mtime; повреждённая база становится недоступной.
Базы приобретаются/обновляются по условиям поставщика; тестовые MMDB в tests/fixtures
не подходят для настоящей геолокации. Без баз и для частных IP интерфейс показывает
недоступность. Дата базы берётся из metadata.build_epoch.

Дополнительные живые проверки: verify-bonuses.py, verify-certificates.py (реальные 5 минут),
verify-client-tls.py и повторная общая приёмка. Не запускать проверки с изменением одного
стенда одновременно.

Финальные проверки из исходников: `uv run pytest -q`, `uv run ruff check src tests scripts infra/migrations`,
`uv run alembic check`; UI из `apps/web`: `npm test -- --run`, `npm run build`.
Живые сценарии в `scripts/verify-*.py` используют подготовленный лабораторный стенд,
а браузерные helpers — `apps/web/scripts/browser`. Условия и результаты находятся в
`docs/evidence`; запуск mutation-проверок одного стенда должен быть последовательным.


Обновление оригинальных DB-IP Lite: `uv run hf-geo-update --directory /absolute/path/to/mmdb`.
Контрольная сумма издателя обязательна для зеркала, официальные HTTPS bytes проходят
валидацию типа/даты/размера до замены. Активная база сохраняется при ошибке. Лицензия
CC BY 4.0, attribution https://db-ip.com. Windows пакет содержит проверенные базы и
автоматически переносит их при Setup. Backup v2 сохраняет их для независимого restore.

High устанавливается отдельно: [HIGH_RUNTIME.md](HIGH_RUNTIME.md). На Windows выделить
Ubuntu-сенсору 4 CPU/8 GB RAM/30 GB disk; KVM зависит от вложенной виртуализации,
TCG — допустимый явно выбранный лабораторный режим с ожиданием до 600 секунд.

### Ротация pin управляющего сервера

Pin фиксирует SPKI публичного ключа leaf-сертификата. Продление сертификата с тем же
ключом не меняет pin. Для смены ключа заранее распространить на сенсоры приватный
`HF_AGENT_SERVER_SPKI_PINS=OLD_PIN,NEW_PIN` из проверенного оператором публичного
сертификата; максимум два значения. Перезапустить asset-sync, затем переключить gateway,
проверить доставку и убрать старый pin после перекрытия. Если cutover выполнен раньше,
неверный pin сохраняет outbox и блокирует запросы; восстановить доверие через
`pin-sensor-server.py` с заранее доверенным CA и проверить событие после рестарта.
Доверие CA/имени не отключается. Клиентские mTLS-ключи вращаются отдельно через
существующую двухфазную выдачу/подтверждение с реальным перекрытием 300 секунд.
