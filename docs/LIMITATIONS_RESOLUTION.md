# Решения ограничений и доказательства

Обновлено по полному ТЗ и текущим исходникам 10 октября 2026. Честные границы являются
частью продукта, а не заменой работающих функций. В IMPLEMENTATION.md отмечена готовность
каждого этапа. Конкретные условия экспериментов находятся в docs/evidence.

| Исходная проблема | Реализованное решение | Проверка | Что нельзя утверждать |
|---|---|---|---|
| Неизвестно, как выиграть | Прочитано полное ТЗ: работоспособность, полнота, маскировка, зрелость, защита. Каждому FR/MASK соответствует сценарий | REQUIREMENTS.md, два живых демо | Не известны веса, жюри, полный регламент. Победа не гарантируется |
| Кнопка не закрывала установленный SSH | Приватный registry транспорта Cowrie, scoped termination command и отдельный ACK с transport IDs | session-termination.json, две реальные EOF в demo-video-results.json | Не изолирует весь компьютер и другие сервисы |
| IP/эмулятор не показывают личность/реальную ОС | Source/provenance, client-claimed banner, kex fingerprint; эмуляция явно подписана | Реальные source/version/kex events | NAT/proxy/IP не доказывают человека. uname описывает легенду ловушки |
| wget/curl не означают загрузку | Реальный SFTP и разрешённый fixture download, независимая проверка bytes/hash, resumable binary delivery | foundation.json, binary-evidence.json, два browser downloads | Произвольный Internet не открыт. Attempt без bytes не доступный артефакт |
| Не было PCAP | AF_PACKET собирает реальные Ethernet/IPv4/IPv6 bytes в ограниченные сегменты | binary-evidence.json, evidence tests | Квоты/snaplen/сбои/drops ограничивают полноту. HTTP PCAP может содержать plaintext |
| Неограниченного вывода нет | Явные capture/input/time/file/disk limits, marker усечения, storage unavailable/503, preserved accepted proof | Low2KiB, shell capture tests, actual ENOSPC | Лимиты могут быть распознаны. Бесконечная запись не обещается |
| Не было Low | Собственный TCP banner без auth/shell; HTTP/Cowrie честно Medium | foundation.json | Cowrie shell не является High |
| Не было remote secure masking | Actual HTTPS, separate gateway/prefix/static root, gateway-only route и neutral asset-sync вне контейнера | masking.json на двух VM/10 traps | Лаборатория использует общий физический интерфейс. Root гипервизора вне модели |
| Не было ролей/дел/интеграций | Четыре server-side роли, optimistic revision cases/pins, scoped pull receiver/key/revoke/response | Role/integration tests + real browser | Это не shared multi-tenant и не сертифицированный коннектор любого SIEM |
| Один local run не доказывает SLA | Длительная нагрузка фиксирует условия, errors/dedupe, отдельно centre/browser latency. Independent backup/restore | scale.json, frontend latency JSON, backup-restore.json | Внешний SLA требует проверки фактического размещения |
| Cowrie закрывал длительные сессии | v2 interactive_timeout1800s, v1 остаётся300s; failed run сохранён и выполнен повтор900s | scale-first-run-failed.json и повтор | Ограничение времени остаётся явным |
| High требует отдельной платформы | Проверка фактических KVM capabilities и документированный backend pool этап | high-capability.json | Обе lab VM не имеют /dev/kvm, High в них unavailable |

Бонусы реализованы и проверены: registry уникальных URL/файлов (bonuses.json),
configurable observed-time detections/late delivery и CSV/STIX (test_bonus.py + real export),
offline MMDB reader (настоящие upstream test fixtures; production базы отдельно),
beacon/persona и mTLS с реальными 300 секунд перекрытия (certificates.json/client-tls.json).
Данные Geo при отсутствии production баз остаются недоступными; High остаётся отдельным
этапом на подходящем KVM-хосте.

Три границы защиты: центр, доверенный сенсор, недоверенная приманка. Agent keys и
Docker socket не попадают внутрь. Смена версии/учёток требует явного redeploy.
Архив сохраняет историю. Удаление занятого профиля отвергается409.

Envelope encryption защищает structured credentials/payload до Docker/stdout/outbox.
Private reveal требует admin/operator/analyst, audit и no-store. Бинарный PCAP и backup
с ключами остаются приватными доказательствами с отдельным доступом. Шифрование каждого
бинарного файла на диске не заявляется.
