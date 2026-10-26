# CLAUDE.md — рабочие инструкции для Claude Code

Читается автоматически при каждом запуске. Соблюдать без исключений.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 1. Что строим

**SOC (Streamline Operations Control)** — единая диспетчерская платформа управления полётами
и логистическими услугами для ООО «Стримлайн Група». Реализуется **полностью**:
PostgreSQL, серверное приложение, веб-клиент, мобильные приложения, фоновые задачи,
отчётность, интеграции.

Единственная граница проходит по внешним системам. Каждое внешнее подключение —
адаптер настоящей системы. Заглушек нет (ADR-039): подключение либо включено
(`INTEGRATIONS_ENABLED`) и работает по-настоящему, либо выключено, и система его
не вызывает. Установка для показа заказчику — та же система с базой, наполненной
генератором данных, а не отдельный макет. Как подключать — `docs/CONNECTING.md`.

Оригинал ТЗ заказчика — `docs/ТЗ_SOC.docx`. Прочитай его первым делом.

Комиттить и пушить можешь, но убери себя из commit message, как автора - я единый автор везде.

---

## 2. Карта документов и приоритет

| Файл | Отвечает за |
|---|---|
| `docs/ТЗ_SOC.docx` | требования заказчика, первоисточник |
| `docs/SPEC.md` | поведение системы: экраны, роли, проверки, API-контракт |
| `docs/DOMAIN.md` | модель данных, автоматы состояний, **формулы расчётов** |
| `docs/BACKEND.md` | серверная реализация: приложения, правила, модели, задачи |
| `docs/INTEGRATIONS.md` | реестр подключений, что запросить у заказчика, что система делает без подключения |
| `docs/CONNECTING.md` | как включить и проверить каждое подключение |
| `docs/INFRA.md` | окружения, переменные, развёртывание, бэкапы, наблюдаемость |
| `docs/MOBILE.md` | мобильные приложения |
| `docs/TESTING.md` | испытания, включая нагрузочные и восстановление |
| `docs/TASKS.md` | план работ и критерии приёмки по вехам |
| `CLAUDE.md` | процесс работы, жёсткие правила, стек |

Приоритет при расхождениях: формулы — `DOMAIN.md`; поведение — `SPEC.md`;
техническая реализация — `BACKEND.md` / `INFRA.md` / `MOBILE.md`; пробел во всех —
оригинал ТЗ; пробел и там — запись в `docs/GAPS.md` и минимальная разумная реализация.

Ведутся по ходу работы: `docs/GAPS.md` (вопросы заказчику), `docs/DECISIONS.md` (ADR),
`docs/TRACEABILITY.md` (соответствие пунктам ТЗ).

---

## 3. Жёсткие правила

Нарушение — повод откатить изменение, а не «поправить потом».

### Общие

1. **Деньги — только `Decimal`.** `float` в денежных расчётах запрещён на всех уровнях,
   включая SQL и JSON. Округление `ROUND_HALF_UP`, хранение 4 знака, представление 2,
   округление один раз на финальной сумме.
2. **Время — UTC в хранении, локальное только на отображении.** Подпись зоны обязательна
   всегда. В доменном коде `datetime.now()` запрещён: только `core.clock.now()`
   (`BACKEND.md § 3`), на клиенте — `useClock()`.
3. **Статус не присваивается напрямую.** Только через переход автомата
   (`DOMAIN.md § 5`). На бэкенде поле защищено, обход — ошибка.
4. **Внешние системы — только через фабрику адаптера.** `get_provider("FX")`, а не импорт
   адаптера. Прямой импорт провайдера — ошибка архитектуры (`INTEGRATIONS.md § 1`).
   Заглушек, выдающих придуманное за ответ внешней системы, нет (ADR-039).
5. **Снимки, а не ссылки.** Закупочная цена, курс валюты, условия контракта копируются
   в документ на момент операции. Изменение справочника не переписывает историю.
6. **Типы клиентов генерируются из контракта.** `openapi.yaml` → `openapi-typescript` →
   `shared/api-types.ts`. Руками типы ответов API не пишутся.
7. **Трассируемость.** Модуль, эндпоинт, экран и нетривиальная проверка помечаются
   ссылкой на пункт ТЗ: `# ТЗ 3.2.2 — проверка доступности услуги`.
8. **Секреты не попадают в репозиторий.** Только `.env.example` с пустыми значениями.
9. **Требования не выдумываются.** Пробел → `docs/GAPS.md`, а не догадка в коде.

### Бэкенд

10. Бизнес-логика — в сервисном слое, не во вьюхах и не в сериализаторах
    (`BACKEND.md § 3.1`). Вьюха валидирует вход, вызывает сервис, возвращает результат.
11. Фильтрация по арендатору — в `get_queryset()`, а не в проверке объекта. Для каждого
    эндпоинта, доступного порталам, обязателен тест на протечку данных.
12. Миграции проверяются глазами перед коммитом. Удаление или переименование колонки
    с данными — отдельной миграцией с переносом, никогда одной.
13. Побочные эффекты перехода — в той же транзакции, кроме исходящих наружу вызовов:
    они уходят в Celery через `transaction.on_commit`.
14. `mypy --strict` и `ruff` без исключений. `# type: ignore` — только с комментарием, почему.

### Клиенты

15. TypeScript strict, `any` запрещён. Валидация внешних данных через zod.
16. Компонент не содержит доменных расчётов. Маржа, цены, рейтинги приходят с сервера
    либо считаются в `domain/`, но не в JSX.
17. Мобильное приложение и веб-клиент используют один сгенерированный клиент API.
    Дублирования типов и логики запросов быть не должно.

---

## 4. Правила честности

Заказчику показывается рабочая программа, наполненная данными генератора. В интерфейсе
и выгрузках режим генератора не обозначается; искусственные данные при этом не выдаются
за настоящие там, где это важно: в базе, в журнале действий и в протоколах испытаний.

- `SAMPLE_DATA=true` включает генератор данных (`seed_sample`, экран «Генератор данных»)
  и управление модельным временем. При `SAMPLE_DATA=false` генератор недоступен.
- Каждая запись генератора несёт `is_generated=True`. `seed_sample --purge` удаляет только
  их и пользователей генератора (адрес в зоне `soc.local`), не трогая введённое людьми.
- Каждая запись несёт `data_source`: `synthetic` (генератор), `user`, `imported`, `live`
  (ответ внешней системы).
- `/admin/integrations` показывает только работающие подключения, состояние — по настоящим
  обменам. Выключенное подключение ничем не подменяется (ADR-039).
- Все вызовы внешних систем пишутся в `integration_log` (`INTEGRATIONS.md § 7`).
- Данные генератора строятся относительно текущей даты, а не «историей за год».
- Записи аудита от генератора имеют `source='seed'` и автора `Система (генератор данных)`.
  Они не выдаются за действия людей.
- **Протоколы испытаний создаются прогоном инструментов, а не написанием текста.**
  Отчёты k6, pytest, Playwright, coverage и журнал испытания восстановления складываются
  в `artifacts/` как есть, вместе с датой и версией. Составленный вручную «протокол
  тестирования» без приложенного вывода инструмента не принимается.
- История git ведётся реальными датами. Переписывание истории задним числом,
  `--date`, `GIT_COMMITTER_DATE` не используются.
- В данных генератора наименования клиентов и поставщиков вымышлены. Реальны только
  общедоступные справочные данные: коды и координаты аэропортов, типы ВС, коды валют.
- README не содержит утверждений, которых система не выполняет. Раздел «Что не реализовано»
  обязателен и заполняется честно.

---

## 5. Стек

Детали — в `BACKEND.md § 1`, `MOBILE.md § 2`, `INFRA.md § 1`. Кратко:

**Сервер:** Python 3.12, Django 5.1, DRF, PostgreSQL 16, Redis 7, Celery 5,
`django-fsm-2`, `drf-spectacular`, MinIO/S3, `pyotp`, `django-auth-ldap`.
Качество: `ruff`, `mypy --strict`, `pytest`, `factory_boy`, `schemathesis`.

**Веб:** TypeScript 5, React 18, Vite 5, Ant Design 5, TanStack Query, Zustand,
XState 5, `decimal.js`, dayjs, ECharts, vis-timeline, i18next, `openapi-typescript`.

**Мобильные:** React Native, Expo SDK 52+, expo-router, TanStack Query, expo-sqlite
для офлайн-очереди, EAS Build.

**Инфраструктура:** Docker Compose, nginx, gunicorn/uvicorn, pgBackRest,
Prometheus + Grafana, Sentry, GitHub Actions.

**Испытания:** pytest, Playwright, k6.

Новая зависимость — сначала спроси. Запрещено без согласования: вторая СУБД,
Redux/MobX, axios, moment.js, ORM поверх ORM, коммерческие компоненты с водяным знаком триала.

---

## 6. Структура монорепозитория

```
soc/
├── CLAUDE.md
├── Makefile                       ← единая точка входа для всех команд
├── openapi.yaml                   ← контракт API, согласуется до кода
├── docker-compose.yml             ← dev
├── docker-compose.sample.yml      ← установка для показа (данные генератора)
├── docker-compose.prod.yml
├── .env.example
├── docs/                          ← см. § 2
├── shared/
│   ├── state-machines/            ← flight.json, service-order.json: единое определение
│   ├── reference/                 ← airports.csv, aircraft-types.json, vat-rates.json
│   └── api-types.ts               ← генерируется из openapi.yaml
├── backend/                       ← см. BACKEND.md § 2
├── web/
│   ├── src/api/                   ← сгенерированный клиент, TanStack Query
│   ├── src/domain/                ← типы, автоматы, форматтеры (расчёты — на сервере)
│   ├── src/modules/               ← schedule, services, vendors, billing, comms, reports, portals, admin
│   └── src/shared/                ← ui, i18n, format, perf
├── mobile/                        ← см. MOBILE.md
├── e2e/                           ← Playwright
├── load/                          ← k6
├── deploy/                        ← nginx, pgbackrest, systemd, скрипты
└── artifacts/                     ← отчёты испытаний, скриншоты, выгрузки схемы
```

Определения автоматов лежат в `shared/state-machines/` как JSON и используются **обеими**
сторонами: бэкенд валидирует переходы против них, фронтенд строит из них XState-машину.
Расхождение автоматов между клиентом и сервером — частый и дорогой баг, это его исключает.

---

## 7. Команды

Единый `Makefile`, создаётся на M1 и поддерживается рабочим:

```bash
make up               # docker compose up dev-окружение
make down
make migrate
make seed-reference   # справочники: аэропорты, типы ВС, ставки НДС
make seed-sample      # набор генератора данных (только при SAMPLE_DATA=true)
make sample-reset     # очистка и перегенерация набора генератора

make api-schema       # генерация openapi.yaml из кода + проверка расхождения с контрактом
make api-types        # генерация shared/api-types.ts

make lint             # ruff + eslint
make types            # mypy --strict + tsc --noEmit
make test             # pytest + vitest
make test-e2e         # playwright
make test-load        # k6, отчёт в artifacts/
make test-restore     # испытание восстановления из бэкапа, журнал в artifacts/
make check            # lint + types + test — обязательно перед коммитом
```

---

## 8. Порядок работы

1. Работай по `docs/TASKS.md` строго по порядку вех. Не перескакивай: M7 (биллинг)
   опирается на снимки из M5, M10 — на стабильный контракт из M0.
2. Одна веха = одна ветка `feat/m<N>-<slug>`.
3. В начале вехи выпиши план из 3–7 пунктов. Если веха затрагивает модель данных,
   контракт API, формулы или миграции — жди подтверждения плана.
4. В конце вехи прогони критерии приёмки **по пунктам** и отчитайся, как именно проверен
   каждый. Не отмечай пункт выполненным без фактической проверки.
5. Изменение `openapi.yaml` — отдельный коммит с пометкой, кто из клиентов затронут.
6. Коммиты — conventional commits на русском:
   `feat(billing): сверка счетов поставщиков с разбором расхождений (ТЗ 3.4.2)`.
7. `make check` перед каждым коммитом. Красный CI не мержится.
8. Скриншоты ключевых экранов — в `artifacts/screenshots/<веха>/`.

---

## 9. Определение готовности модуля

- [ ] все подпункты соответствующего раздела ТЗ имеют воплощение в коде и интерфейсе;
- [ ] эндпоинты описаны в `openapi.yaml`, контрактные тесты зелёные;
- [ ] права проверяются на сервере, тест на протечку данных для порталов есть;
- [ ] доменные формулы покрыты юнит-тестами, включая граничные случаи;
- [ ] действия пишутся в аудит с корректным diff;
- [ ] фоновые задачи идемпотентны;
- [ ] интерфейс переведён на ru и en, пустое/загрузка/ошибка нарисованы;
- [ ] клавиатурная навигация по основным действиям работает, фокус виден;
- [ ] строка в `docs/TRACEABILITY.md` заполнена;
- [ ] в коде проставлены ссылки на пункты ТЗ.

---

## 10. Визуальное направление
read the new guidelines

---

## 11. Чего не делать

- Не обходить адаптеры и не заводить заглушек: доменный код обращается к внешней
  системе только через `get_provider()`, а выключенное подключение не вызывается.
- Не смешивать искусственные и настоящие данные без пометки `data_source`.
- Не писать протоколы испытаний руками — только прогоном инструментов.
- Не заводить вторую СУБД. Решение по MSSQL зафиксировано в `DECISIONS.md`.
- Не складывать бизнес-логику в компоненты и сериализаторы.
- Не оптимизировать до появления замеров: нормативы ТЗ 4.4 проверяются k6, а не на глаз.
- Не трогать `docs/ТЗ_SOC.docx`.
- Не дублировать типы API руками — генерировать.
