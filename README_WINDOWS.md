# HoneyForge — комплект для Windows

Начать с **START_WINDOWS.cmd**. Он собирает и запускает настоящий центр с PostgreSQL,
FastAPI, интерфейсом и двумя HTTPS gateway. Для приманок нужен отдельный Ubuntu 24.04
сенсор: виртуальная машина на этом же компьютере или отдельный Linux-компьютер.

## 1. Что требуется

- Рекомендуемая машина: Windows 11 x64, 16 GB RAM, 4+ CPU, 30 GB свободного места на NTFS.
  Это запас для установки, не измеренное минимальное требование продукта.
- Включённая виртуализация Intel VT-x / AMD-V в BIOS/UEFI.
- Docker Desktop с Linux containers и WSL2 backend. Актуальные ограничения ОС, WSL и
  лицензии: [Docker Desktop Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
- Интернет при первой установке: Windows/WSL, образы, Python/Node зависимости, Ubuntu ISO.
  Архив содержит исходники и сценарии; установщики ОС и сохранённые Docker images в него
  не входят. Последующие запуски без пересборки используют локальные образы.
- Ubuntu Server **24.04 LTS**, systemd, 2+ CPU, 4 GB RAM и 15 GB диска для сенсора.
  Для 10 ловушек выделить больше RAM по фактическому потреблению.
- Edge или Chrome. Нативный Python/Node/Git на Windows для центра не нужны.

Архив не содержит действующие ключи, пароли, регистрации, рабочую БД центра и данные стенда.
Публичные базы DB-IP City/ASN Lite включены отдельно в `data/geo` с лицензией и контрольными суммами.
Документы и результаты старого Linux-стенда в `docs/evidence` — исторические доказательства,
не результаты проверки вашего Windows-компьютера. Функциональность без нейросетей.

## 2. Подготовка Windows

1. Распаковать ZIP через Проводник → «Извлечь всё» в `C:\HoneyForge`. Внутри будет папка
   `HoneyForge-Windows`; открыть её. Не запускать из окна просмотра ZIP, OneDrive или сетевой папки.
2. Если Docker Desktop ещё нет: правой кнопкой по **INSTALL_PREREQUISITES.cmd** →
   «Запуск от имени администратора». Сценарий включает WSL/Virtual Machine Platform,
   обновляет WSL и устанавливает Docker Desktop через winget.
3. Если появится сообщение о перезагрузке, перезагрузить Windows вручную и повторить шаг 2.
   Скрипт не перезагружает компьютер и не удаляет существующие WSL дистрибутивы.
4. Открыть Docker Desktop, закончить его стартовые экраны. В Settings → General включить
   **Use the WSL 2 based engine**. Дождаться **Engine running**. Контейнеры должны быть Linux.
   При нехватке памяти пример `scripts/windows/wslconfig.example` можно вручную объединить
   с `%USERPROFILE%\.wslconfig`. Он влияет на все WSL2 дистрибутивы; сначала сохранить свой
   файл. Применяется после остановки Docker Desktop и `wsl --shutdown` (остановит все WSL).
   Описание: [Microsoft WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
5. Для рекомендуемого стенда с Host-only сначала выполнить раздел 3, шаги 1–7:
   создать сеть и Ubuntu VM, записать оба IP. Затем запускать центр с IP **Windows host-only**
   как на шаге 6 ниже, от обычного пользователя. Если уже есть отдельный Linux-сенсор
   в той же сети, можно дважды нажать **START_WINDOWS.cmd**: один активный Windows
   интерфейс определяется автоматически. Первичная сборка скачивает зависимости.
6. При нескольких сетевых интерфейсах открыть PowerShell в папке проекта и указать IP
   Windows, который будет доступен Ubuntu-сенсору:

   ```powershell
   .\START_WINDOWS.cmd -Action Setup -ManagementAddress 192.168.1.10
   ```

   Здесь и ниже IP — **пример**, его заменить своим. Найти адрес: Settings → Network &
   Internet → текущий Ethernet/Wi-Fi → Properties → IPv4 address. Для VirtualBox host-only
   указать IPv4 соответствующего host-only интерфейса Windows, например `192.168.56.1`.
7. Сценарий создаст собственные случайные секреты, закрытый каталог `.runtime\windows`,
   приватные CA и установит **только публичный корень консоли** в Current User → Trusted Root.
   HTTPS проверяется, ошибки сертификата не обходятся.
8. Откроется **https://localhost:8443**. Если браузер открыт заранее, перезапустить его
   после установки CA. Не заменять localhost на IP/127.0.0.1: origin и сертификат привязаны к имени.
9. Открыть `.runtime\windows\access.txt` локально: там логин `operator` и случайный пароль.
   Войти. Не показывать этот файл жюри. При повторном Setup пароль и данные сохраняются.

Порты центра: консоль `127.0.0.1:8443`, HTTP redirect `127.0.0.1:8080`, management
`WINDOWS_IP:18443`. PostgreSQL и API не публикуются. Management обслуживает имя `asset-sync.test` с проверяемым TLS сертификатом и имеет отдельный
`/assets/sync/v1`; внешних Swagger/OpenAPI и `/agent/v1` нет.

## 3. Виртуальная машина сенсора на Windows

Рекомендуемый локальный вариант: отдельная Ubuntu VM. WSL используется Docker Desktop
для центра; сенсор туда не устанавливаем: firewall/PCAP должны видеть тот же Linux Docker
Engine, который запускает приманки. `install-sensor-ubuntu.sh` отклоняет WSL и контейнеры.

Для Windows Pro/Enterprise можно использовать Hyper-V VM с подходящей сетью. Универсальный
вариант для Windows x64 — VirtualBox. Инструкция ниже использует **NAT + Host-only**, чтобы
демо не зависело от Wi-Fi bridge и не открывало приманки всей локальной сети.

1. Установить [VirtualBox](https://www.virtualbox.org/wiki/Downloads), скачать ISO
   [Ubuntu Server 24.04 LTS](https://releases.ubuntu.com/24.04/).
2. VirtualBox → Tools → Network → Host-only Networks → Create. Записать IPv4 адаптера
   Windows; включить DHCP. Не выбирать сеть `10.88.0.0/30` или `10.89.0.0/30` — их использует агент.
3. New → имя `HoneyForge Sensor` → Linux / Ubuntu (64-bit), ISO Ubuntu 24.04.
   CPU 2, RAM 4096 MB, disk 20 GB. Для понятной установки можно выбрать Skip Unattended Installation.
4. Settings → Network → Adapter 1: NAT (нужен для загрузки пакетов).
   Adapter 2: Enable → Host-only Adapter → созданный на шаге 2 интерфейс.
5. Settings → Shared Folders: пусто. General → Advanced: Shared Clipboard и Drag'n'Drop Disabled.
   Агент и его управляющие ключи не передаются в контейнеры приманок.
6. Start → установить Ubuntu. На экране SSH setup выбрать **Install OpenSSH server**.
   Создать обычного Linux пользователя и пароль. Удалить ISO после установки, перезапустить VM.
7. В Ubuntu выполнить `ip -4 -br addr`: записать IP host-only интерфейса,
   например `192.168.56.101`. Это **SENSOR_IP**, не NAT IP типа `10.0.2.15`.
   При отсутствии адреса добавить второй интерфейс с DHCP в Ubuntu Network configuration/netplan.
   Для стабильного стенда закрепить адреса Windows и VM в выбранной сети до регистрации.
8. Центр настроить с **ManagementAddress = IPv4 Windows host-only интерфейса**.
   Выполнить раздел 2, шаг 6 с этим IP. Если центр уже настроен с другим адресом,
   не создавать новые данные: см. «Смена адресов».
9. В PowerShell от администратора открыть порт management только для этой VM:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Allow-Sensor.ps1 -SensorAddress 192.168.56.101
   ```

   Создаётся одна именованная входящая TCP rule на 18443, только для SENSOR_IP.
   Остальные правила Windows Firewall не меняются. Корпоративная политика может запретить
   локальную rule; тогда нужен доступ, разрешённый владельцем сети.

Официальная документация: [сеть VirtualBox](https://www.virtualbox.org/manual/ch06.html),
[установка WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

## 4. Установка и регистрация сенсора

1. В PowerShell из папки комплекта скопировать **только сенсорный архив и публичный CA**
   (подставить имя своего Linux пользователя и IP VM):

   ```powershell
   scp .\sensor-source.zip .\.runtime\windows\management-ca.crt demo@192.168.56.101:~/
   ssh demo@192.168.56.101
   ```

   Если scp/ssh не найдены: Settings → System → Optional features → Add an optional feature →
   **OpenSSH Client**. Для первого SSH подтвердить fingerprint своей VM; сверить его в её консоли:
   `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
2. Уже в Ubuntu:

   ```sh
   sudo apt-get update
   sudo apt-get install -y unzip
   unzip sensor-source.zip -d honeyforge-sensor-source
   cd honeyforge-sensor-source
   sudo bash scripts/windows/install-sensor-ubuntu.sh https://asset-sync.test:18443 192.168.56.101 ~/management-ca.crt 192.168.56.1
   ```

   Первый IP — адрес VM, последний — Windows management на host-only сети. Установщик добавляет
   в /etc/hosts сенсора имя `asset-sync.test` для указанного IP и проверяет
   Ubuntu/systemd/IP, создаёт `/opt/asset-sync`, устанавливает Docker, образы, отдельную
   management-сеть и ограничения приманок. Служба работает вне контейнеров.
3. Дождаться строки **Verified management HTTPS reachable**. Если ошибка — исправить IP,
   firewall или CA. Не использовать insecure / отключение проверки сертификатов.
4. Открыть панель → **Хосты** → создание токена регистрации. Создать токен **сейчас**,
   после завершения сборок: он живёт 10 минут и применяется один раз.
5. Вставить токен в ожидающий терминал Ubuntu. Ввод скрыт. Токен не передаётся аргументом
   процесса, временный файл имеет mode0600 и удаляется после успешной регистрации.
6. Служба `asset-sync` запускается. В панели дождаться **Online** и индивидуального mTLS
   сертификата. Пустой список событий до подключения — нормальное состояние.

Повторный установщик из `/opt/asset-sync/scripts/windows/install-sensor-ubuntu.sh` сохраняет
identity/outbox. Если ключ отозван, не пытаться вернуть старую identity: зарегистрировать
новый отдельный сенсор по процедуре администратора. Приватные файлы центра на VM не копировать.

## 5. Подготовка трёх настоящих ловушек

В PowerShell в папке Windows-комплекта:

```powershell
.\START_WINDOWS.cmd -Action Demo -SensorAddress 192.168.56.101
```

Сценарий работает через реальный API, выбирает **ровно один** зарегистрированный Online/
Degraded хост с указанным IP и создаёт профили v2 и развёртывания:

| Ловушка | Адрес примера | Что делает |
|---|---|---|
| Low TCP | `192.168.56.101:2223` | Баннер SSH и простой ответ, запись реального соединения |
| Medium SSH | `192.168.56.101:2222` | Cowrie, команды, плеер, SFTP, синтетические файлы |
| Medium HTTP | `http://192.168.56.101:18080` | Фальшивая админка, HTTP payload и credentials capture |

Дождаться вывода endpoint и **Running** в «Ловушки». Сценарий не рисует fake события и
не заменяет подтверждение агента. Повторный Demo использует уже созданные профили/ловушки.
При конфликте порта, отозванной identity или ошибке runtime исправить причину в панели.
Учебная SSH учётка только внутри приманки: **root / hackathon-demo**, не пароль Ubuntu или панели.

## 6. Живое демо на Windows

Разделить экран: PowerShell слева, браузер справа. В браузере открыть события или плеер.

1. Реальная Low-проверка в PowerShell:

   ```powershell
   $client = [Net.Sockets.TcpClient]::new('192.168.56.101', 2223)
   $stream = $client.GetStream()
   $stream.ReadTimeout = 3000
   $buffer = New-Object byte[] 512
   $length = $stream.Read($buffer, 0, $buffer.Length)
   [Text.Encoding]::UTF8.GetString($buffer, 0, $length)
   $bytes = [Text.Encoding]::UTF8.GetBytes("demo-probe`r`n")
   $stream.Write($bytes, 0, $bytes.Length)
   $client.Dispose()
   ```

   В ленте появляются реальные Low connection/input/close события.
2. SSH из нового PowerShell:

   ```powershell
   ssh -p 2222 root@192.168.56.101
   ```

   Ввести учебный пароль `hackathon-demo`. Выполнить `whoami`, `hostname`, `uname -a`,
   `cat /home/admin/backup-notes.txt`. Оставить SSH открытым; на панели открыть его сессию:
   новые команды и вывод появляются в плеере через SSE.
3. HTTP: открыть `http://192.168.56.101:18080` в браузере, отправить **синтетические**
   логин/пароль. В карточке события выполнить просмотр защищённой записи разрешённой ролью.
4. SFTP, отдельная сессия:

   ```powershell
   'HoneyForge SAFE DEMO FILE' | Set-Content -Encoding ascii .\safe-demo.txt
   Get-FileHash -Algorithm SHA256 .\safe-demo.txt
   sftp -P 2222 root@192.168.56.101
   ```

   В SFTP: `put safe-demo.txt /tmp/safe-demo.txt`, затем `bye`. Открыть именно эту SFTP
   сессию в панели, дождаться артефакта, скачать и сравнить SHA-256.
5. В открытой SSH сессии панели создать ограничение для реального source IP этой сессии:
   выбрать нужную ловушку, срок и **завершение активного SSH**, подтвердить действие.
   Ждать подтверждение выполнения агента; терминал должен получить закрытие соединения.
   Это блокировка источника на выбранной ловушке и завершение её сессии, не изоляция всего PC.
6. Снять ограничение, дождаться подтверждения. Повторить SSH: новое подключение должно пройти.
7. Закрепить сессию в деле, показать PCAP и экспорт. Не запускать/открывать содержимое неизвестных
   файлов на Windows. Для demo достаточно безопасного текстового файла выше.

Если после redeploy SSH сообщает changed host key, сначала убедиться, что это **своя**
пересозданная ловушка; затем удалить только её запись:
`ssh-keygen -R '[192.168.56.101]:2222'`. Глобальную проверку host keys не отключать.

## 7. Обычное управление

```powershell
.\START_WINDOWS.cmd -Action Start
.\START_WINDOWS.cmd -Action Doctor -SensorAddress 192.168.56.101
.\START_WINDOWS.cmd -Action Stop
```

Start открывает консоль, Stop сохраняет все volumes. Doctor проверяет HTTPS центра,
состояние контейнеров и доступность выбранных портов. Наличие порта не доказывает сбор
телеметрии: итоговая проверка — реальное событие и подтверждённое действие в панели.

Сенсор в Ubuntu: `sudo systemctl status asset-sync --no-pager`;
`sudo journalctl -u asset-sync -n 60 --no-pager`. Его очередь сохраняется при недоступном центре.
Остановить перед выключением VM: `sudo systemctl stop asset-sync`, затем `sudo poweroff`.
Не применять `docker compose down -v` к центру: это удаление доказательств и ключей.

`.sh` для WSL/Git Bash: из папки комплекта выполнить `bash setup-windows.sh`.
Он передаёт управление тому же PowerShell сценарию, а не создаёт вторую установку.
Для управления: `bash setup-windows.sh -Action Start`.

## 8. Backup / restore

Закрыть демо, оставить Docker Desktop работающим, выполнить:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Backup.ps1 -OutputDirectory C:\HoneyForgeBackups\before-defense
```

Backup на время останавливает API и gateways, сохраняет SQL, бинарные доказательства,
приватные ключи расшифровки, client CA, обе server CA, env и SHA-256 manifest; затем
возвращает центр. Сенсор в это время буферизует события. Резервная копия **приватная**;
не добавлять её в публичный ZIP/Git/презентацию. Outbox сенсора находится на отдельной VM
и в backup центра не входит; для переноса VM сохранить её приватный диск отдельно.

Восстановление — на чистом Docker проекте и в свежей распакованной папке, **до Setup**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Restore.ps1 -BackupDirectory C:\HoneyForgeBackups\before-defense
```

Требуется тот же закреплённый management IPv4. Restore проверяет каждый обязательный хеш,
отказывает при уже существующих volumes/credentials и не удаляет данные. Сначала возвращает
DB/файлы/ключи/CA при выключенном API, затем запускает центр. Пароль панели прежний и
хранится в приватном `production.env`; после restore `access.txt` не создаётся.
Исходный центр выключить: две независимые активные копии одной identity недопустимы.
После restore повторить login → событие → download/hash → расшифровка разрешённой ролью.

## 9. Смена адресов и типичные ошибки

| Симптом | Проверка / действие |
|---|---|
| WSL/VM не стартует | BIOS virtualization, Windows optional features, перезагрузка; [Microsoft WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting) |
| Docker не найден/не работает | Docker Desktop → Linux containers, Engine running, обновить; повторно открыть терминал после установки |
| Порт 8443/18443 занят | Doctor/`Get-NetTCPConnection`; остановить владельца порта, не убивать неизвестный процесс автоматически |
| Браузер не доверяет HTTPS | Повторить Start от того же Windows пользователя, перезапустить браузер; для управляемого браузера проверить корпоративный trust store |
| HTTP redirect не работает | Локальная консоль открывается напрямую `https://localhost:8443`; HTTP порт8080 только вспомогательный |
| POST403 | Открыть точный URL localhost:8443; обновить login/CSRF; не отключать Origin protection |
| Сенсор не видит центр | IP Windows host-only, CA, Allow-Sensor rule и VM Adapter2; из VM проверить TLS установщиком |
| VM видна только по NAT IP | Adapter2 host-only должен иметь свой адрес; использовать его в registration и demo |
| Хост Offline | asset-sync/network/firewall units, management cert/CA, IP; службу восстановить, локальную очередь не стирать |
| Хост Degraded | Посмотреть реальные collection/artifact/drop ошибки; не сбрасывать counters ради зелёного статуса |
| Ловушка Error | Job detail, конфликт порта, отсутствующий образ/ресурсы; не выдавать Error за Running |
| События отсутствуют | Реально обратиться к правильному endpoint, снять фильтр ленты, проверить heartbeat/queue |
| API чужого старого стенда | Windows-комплект использует свой Compose project honeyforge-windows и localhost8443; порты5173/8100 старого Mac здесь не используются |

**IP Windows изменился:** лучше вернуть закреплённый host-only IP. Если нужна миграция,
остановить центр и агент, сохранить backup, изменить `HF_MANAGEMENT_BIND` в приватном production.env и
`managementAddress` в config.json; на VM обновить запись `asset-sync.test` в `/etc/hosts`.
Имя `asset-sync.test` и `HF_AGENT_API` сохраняются. Пароли и proxy secret сохранять. После Start gateway
продолжает использовать сертификат имени `asset-sync.test`; публичный root не меняется.
Перезапустить на VM `asset-network.service`, затем `asset-sync.service`, обновить
Allow-Sensor rule и проверить TLS/mTLS/живые события. Ошибка при смене IP не повод
отключать проверку сертификатов. Если меняется именно имя, требуется действительный новый leaf сертификат.

**IP VM изменился:** вернуть старый закреплённый адрес. Адрес зарегистрированного хоста
не меняется сам по DHCP. Для планового переноса остановить старые ловушки, сохранить
доказательства, отозвать старый хост и зарегистрировать новый; старую историю не удалять.

## 10. Честная приёмка на вашем Windows PC

- [ ] Центр Ready по проверенному HTTPS; login работает без bypass TLS/CSRF.
- [ ] Ubuntu VM отдельная, без shared folders; агент вне приманок, mTLS активен.
- [ ] Low + Medium SSH + HTTP получили реальный Running от агента.
- [ ] Low probe и SSH команды появились в панели; SFTP download hash совпал.
- [ ] PCAP доступен; protected-record reveal создаёт audit; viewer получает отказ.
- [ ] Ограничение и завершение SSH подтверждены, после снятия новое SSH возможно.
- [ ] Центр Stop/Start: старые события сохранились, локальная очередь доставилась.
- [ ] Новый приватный backup; независимый restore проверен отдельно перед заявлением о нём.
- [ ] Два полных прогона сценария без ручного изменения событий/БД.

Результаты исходной проверки комплекта: `docs/evidence/windows-package.json`.
Текущий локальный Windows-стенд проверен с Low TCP, Medium HTTP и Medium SSH.
Не переносите показатели прежних нагрузочных прогонов на этот компьютер.
Реальная личность/ОС посетителя по IP не определяется. Оригинальные DB-IP
City/ASN Lite включены в комплект; настройка других MMDB остаётся возможной.

## Состав комплекта

- `START_WINDOWS.cmd` / `scripts/windows/HoneyForge.ps1` — Setup/Start/Stop/Doctor/Demo.
- `INSTALL_PREREQUISITES.cmd` — Windows features, WSL, Docker Desktop.
- `setup-windows.sh` — тот же запуск из WSL/Git Bash.
- `compose.windows.yml` / `infra/Caddyfile.windows` — локальная HTTPS консоль.
- `sensor-source.zip` / `install-sensor-ubuntu.sh` — только исходники доверенного сенсора.
- `Allow-Sensor.ps1`, `Backup.ps1`, `Restore.ps1` — firewall, согласованный backup/restore.
- Исходники frontend/backend/agent, lockfiles, миграции, тесты и техническая документация.
- `deliverables/HoneyForge-Windows-defense-v4.pptx` и `HoneyForge-Windows-defense-guide.md` — актуальные материалы защиты.


## Дополнение: профили v3 и Geo

Setup переносит оригинальные DB-IP City/ASN Lite October 2026 из `data/geo`, проверяя
SHA-256 manifest. Обе базы доступны сразу без повторного скачивания; карта для private IP
остаётся недоступной. Обновить: `START_WINDOWS.cmd -Action Geo`. Для Geo updater Интернет
нужен; при ошибке старые базы сохраняются. Attribution: DB-IP, CC BY 4.0.

Конструктор → «Несколько сервисов»: 2–8 HTTP/SSH/Low, собственные порты и настройки.
Опубликовать → создать группу → совместимый сенсор → запустить. Дождаться Running каждого
сервиса. На странице группы Stop/Redeploy применяются ко всем дочерним ловушкам;
переразвёртывание сохраняет выбранные порты.

Backup format v2 включает Geo; Restore понимает прежний v1 и новый v2. Восстановление
доказательств/ключей не требует подключения к Geo publisher.
