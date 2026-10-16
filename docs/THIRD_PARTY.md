# Сторонние компоненты и собственный вклад

Машиночитаемый перечень прямых зависимостей, закреплённых установленных версий и
лицензионных metadata находится в THIRD_PARTY.json. Полные transitive versions
сохраняются в uv.lock и apps/web/package-lock.json. Этот notice не заменяет
LICENSE/NOTICE каждого компонента, которые остаются в установленных пакетах и образах.

| Компонент | Что поставляет | Собственная работа HoneyForge |
|---|---|---|
| Cowrie, BSD-3-Clause | SSH/SFTP протокол и эмуляция shell | Конфигурация профиля, sealed login, session-control, live output, безопасная доставка файлов |
| FastAPI / Pydantic | HTTP и проверка схем | Доменный контракт, команды, RBAC, аудит, согласованные транзакции |
| PostgreSQL | SQL/JSONB/FK/транзакции | Версии, jobs, generations, event idempotency, investigation и retention |
| Cryptography | AES-GCM / RSA-OAEP примитивы | Scope/AAD, envelope, жизненный цикл ключей и отдельное аудируемое раскрытие |
| Docker/Moby | Container runtime | Adapter allowlist, limits, bridge policy, readiness и reconcile |
| Caddy, Apache-2.0 | TLS/proxy | Раздельные gateways, неприметный маршрут, конфигурация установки |
| React / TanStack Query / CodeMirror | UI, server-state, редактор | Сценарии конструктора, расследования, плеера, реакций и ошибок |
| Lucide | Иконки | Компоновка реального интерфейса |
| MaxMind DB reader, Apache-2.0 | Offline MMDB parsing | Honest missing states, build date and observed source ranking |
| stix2, BSD-3-Clause | Independent STIX validation in acceptance | Own Observed Data exporter with provenance |
| Inter, OFL-1.1 | Шрифт | Иерархия и сетка интерфейса |

Образы закреплены digest в infra/Dockerfile.*, версии lockfiles воспроизводимы.
Собственные TCP/HTTP сенсоры, agent outbox, control/telemetry/investigation services,
front workflows и acceptance scripts являются исходниками этого проекта.

Mobbin используется как источник референсов взаимодействия. Канонические ссылки и
соответствие экранов находятся в UI_REFERENCES.md и references/manifest.json.
Референсные скриншоты не являются разработанным продуктом и не выдаются за него.

Генерация кода помощником относится к процессу разработки. Runtime не вызывает AI API.
Правила хакатона по авторству/использованию помощников нужно сверить с регламентом,
когда организатор предоставит его. Победа и оценка жюри не являются измеренным свойством.

MaxMind upstream test MMDB fixtures use the Apache-2.0 license option; LICENSE and pinned
source/checksums are under tests/fixtures/mmdb. They are tests, not a usable geography database.
Production databases require a separate legitimate source and its license/update process.


Дополнение: QEMU GPL-2.0 (системные Ubuntu пакеты на сенсоре), cloud-image-utils GPL-3.0
(создание seed), Ubuntu Minimal 24.04 (официальный cloud image, лицензии пакетов Ubuntu),
Paramiko LGPL-2.1 (SSH readiness гостя). Они обеспечивают VM/SSH примитивы; собственная
работа: trusted per-transport broker, disposable overlays, внешняя политика сети,
проверка baseline, admission/resource budgets, cleanup/recovery и интеграция плеера.
DB-IP City/ASN Lite: CC BY 4.0, https://db-ip.com, исходные MMDB без изменений,
release 2026-10; metadata/hash/license включены в Windows пакет.
