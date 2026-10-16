# Реальные референсы интерфейса HoneyForge

Публичный продукт с точным названием HoneyForge при поиске не найден. Для предметных референсов изучены реальные экраны Thinkst Canary, а для редактора — конкретные экраны рабочих сервисов в Mobbin.

## Thinkst Canary

- [Remote management / Configure Canary](https://help.canary.tools/hc/en-gb/articles/360012820178-Do-the-birds-support-remote-management): просмотрены экраны редактирования сервисов. Применены настройки по сервису, скрытые дополнительные параметры и отдельная публикация конфигурации.
- [Docker Canary](https://help.canary.tools/hc/en-gb/articles/4409802895761-How-do-I-launch-a-Docker-Canary): просмотрен реальный экран Standard Linux Server с активными сервисами, портами и раскрываемыми техническими сведениями. Применены понятный образ сервиса и спокойная иерархия основных параметров.
- [Personality/services](https://help.canary.tools/hc/en-gb/articles/360007291358-Which-personalities-services-does-my-Canary-support): смысл пресетов. В HoneyForge образ меняет только поддерживаемые протокол, легенду, баннер и файлы; эмуляция сетевого OS fingerprint не заявляется.
- [Custom webroots](https://help.canary.tools/hc/en-gb/articles/360015523777-Upload-custom-webroots-to-your-Canary): изучена реальная кастомизация HTTP. Загрузка произвольного HTML/ZIP не добавлена, поскольку текущий backend поддерживает два фиксированных шаблона.

Зелёные рамки на иллюстрациях Canary — аннотации документации; в интерфейс они не переносились. Исходники или бренд стороннего продукта не копировались.

## Mobbin — итоговый конструктор

- [Resend: редактор HTML и предпросмотр](https://mobbin.com/screens/c62b7d91-0c7d-4953-9ee1-3b0b056bc43c): две рабочие панели, единая строка инструментов, разделение редактирования и результата.
- [Vercel: New Project](https://mobbin.com/screens/8234b183-6909-4963-bf81-b63b743beaee): основные поля на виду, дополнительные настройки свёрнуты, одно главное действие.
- [Supabase: SQL editor](https://mobbin.com/screens/fe760737-5cf1-482a-ad17-b44e3e3cf39f): дерево документов, номера строк, спокойный редактор и отдельное рабочее пространство.

Все три изображения просмотрены и сохранены рядом; постоянные ссылки — в manifest.json. Реализация: CodeMirror 6, JSON syntax, native search/replace/history, выбор файлов, расширение редактора, текущая конфигурация в локальном предпросмотре.

## Другие реализованные экраны

- [Vercel: список развёртываний](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54): компактные строки ресурсов.
- [Vercel: прогресс](https://mobbin.com/screens/787123a5-8a85-4d1b-838f-705673a0c820) и [логи](https://mobbin.com/screens/50a79ff4-37c0-4a9b-8df3-29599652a9fb): состояние процесса и технические подробности.
- [Sentry: событие](https://mobbin.com/screens/4ade8a5e-270c-4950-b6c7-343fab511a4b), [инспектор](https://mobbin.com/screens/fdf031bb-18ca-41a6-96e8-702a030024a1), [фильтры](https://mobbin.com/screens/b058eb95-555c-49ac-986d-430776a4e53c): таблица наблюдений, раскрываемые фильтры и контекст события.
- [Linear: проект](https://mobbin.com/screens/649fcb71-a33d-420b-aa0f-aecb25070e13) и [меню действий](https://mobbin.com/screens/eb3e1166-31dc-4fc5-846f-4de5f0782952): компактная навигация и тихие вторичные действия.
- [Vercel: подтверждение](https://mobbin.com/screens/a5ac35a4-139a-4c45-a7fa-e2698143c045), [настройка проекта](https://mobbin.com/flows/edfece19-b9e5-482a-b867-ec0e47ff61ad): проверка параметров перед применением.

Статические референсы не подтверждают исходные анимации. Переходы и поддержка prefers-reduced-motion выбраны для HoneyForge самостоятельно. Эти изображения — референсы дизайна, а не доказательства работоспособности backend.

## LIVE player and investigations — 2026-10-10

Actual Mobbin screens inspected and saved locally:

- [Sentry replay player](https://mobbin.com/screens/773f755a-fb69-41da-b630-2a65fe5afad2): a dominant playback surface, a separate evidence sidebar and bottom transport controls. Applied to the real session player with pause, catch-up, seeking and rule evidence.
- [Cloudflare resource bindings](https://mobbin.com/screens/f76e7a13-9f1e-4653-bcff-72881f441b66): explicit resource nodes and connections. Applied to observed source → deployment → agent host; no geographic or inferred identity layer.
- [Square block list](https://mobbin.com/screens/520d7360-b95f-4936-9ea2-bb52c929e16d): reason and operator context remain readable in the action register. Applied to source-policy records with the backend's own TTL, revision and actual agent acknowledgement.

Animations are local design decisions: finite new-observation emphasis and reduced-motion support. Static reference screens are not claimed as evidence for their motion.
