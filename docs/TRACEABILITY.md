# TRACEABILITY.md — соответствие требованиям ТЗ

Таблица соответствия каждого требования оригинала `docs/ТЗ_SOC.docx` его воплощению
в коде, интерфейсе и испытаниях. Заготовка создана на M0, заполняется по мере закрытия вех.

**Приёмка (`CLAUDE.md § 9`, M17):** строк без статуса быть не должно.

## Словарь статусов

| Статус | Значение |
|---|---|
| `план` | запланировано, веха не начата |
| `в работе` | веха идёт |
| `реализовано` | реализовано и проверено тестом, указанным в строке |
| `реализовано (без подключения)` | функция реализована, внешнее подключение не предоставлено заказчиком; в колонке «Примечание» указано, что требуется для подключения (`CONNECTING.md`). Заглушек нет (ADR-039) |
| `вне объёма` | не реализуется по согласованию; основание — запись в `GAPS.md` или ADR |
| `требует решения` | ожидается ответ заказчика, работа заблокирована |

Колонка «Тест» указывает способ фактической проверки. Пункт не помечается `реализовано`
без указанного и зелёного теста (`CLAUDE.md § 8` п. 4).

---

## Раздел 2. Объекты автоматизации

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-2.1-01 | 2.1 | Роль «Диспетчерская служба» | `accounts.permissions` роль `dispatcher` | `GET /auth/me` | все операционные | `tests/test_permissions.py::TestPermissionMap` | M3 | реализовано |
| T-2.1-02 | 2.1 | Роль «Отдел продаж» | `accounts` роль `sales` (ADR-011) | `/auth/me` | `/billing/quotes` | `test_permissions_sales` | M3 | требует решения (G-06) |
| T-2.1-03 | 2.1 | Роль «Финансовый отдел» | `accounts.permissions` роль `finance` | `GET /auth/me` | финансовые | `tests/test_permissions.py::TestPermissionMap` | M3 | реализовано |
| T-2.1-04 | 2.1 | Роль «Руководство» | `accounts.permissions` роль `manager` | `GET /auth/me` | `/dashboards/manager` | `tests/test_permissions.py::test_only_admin_and_manager_read_audit` | M3 | реализовано |
| T-2.1-05 | 2.1 | Роль «Клиенты (авиакомпании)» | `accounts` роль `client` + фильтр арендатора (`TenantScopedViewSet`, 404 вместо 403) | `/portal/client/*` | портал клиента | `portals/tests/test_portals.py::test_client_sees_only_own_flights`, `tests/test_tenant_isolation.py::TestClientPortalIsolation` | M3, M8 | реализовано |
| T-2.1-06 | 2.1 | Роль «Поставщики услуг» | `accounts` роль `vendor` + фильтр арендатора (`TenantScopedViewSet`) | `/portal/vendor/*` | портал поставщика | `portals/tests/test_portals.py::test_vendor_does_not_see_another_vendors_orders`, `tests/test_tenant_isolation.py::TestVendorPortalIsolation` | M3, M8 | реализовано |
| T-2.2-01 | 2.2 | Планирование с учётом ограничений: слоты | реестр `Slot` (ADR-026), условие перехода `ready` — `slot_confirmed_if_coordinated`. **Не сделано:** испытания условия (переход в «Готов к вылету» без подтверждённого слота в координируемом аэропорту) нет | `GET /slots` | `/slots`, `/schedule` | `flights/tests/test_slots.py` (реестр слотов); условие перехода испытанием не покрыто | M4 | в работе |
| T-2.2-02 | 2.2 | Планирование с учётом ограничений: допуски | `fleet.AircraftApproval` (ADR-027), проверка срока допуска борта в детекторе конфликтов. **Не сделано:** `CrewQualification` (допуски экипажа по ADR-027) не заведена | `GET /fleet/{id}/approvals` | `/fleet/:id` | `flights/tests/test_conflicts.py::TestApprovals::test_approval_expiring_before_the_flight_is_a_conflict`, `fleet/tests/test_fleet_create.py::test_aircraft_is_added_with_approvals` | M4 | в работе |
| T-2.2-03 | 2.2 | Планирование с учётом техсостояния ВС | `fleet.Aircraft.status`; борт в AOG или на ТО — конфликт рейса | `GET /fleet` | `/fleet` | `flights/tests/test_conflicts.py::TestAircraftState::test_aog_aircraft_is_a_conflict`, `TestAircraftState::test_maintenance_is_a_conflict` | M4 | реализовано |

---

## Раздел 3.1. Модуль «Суточный план полётов»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.1.1-01 | 3.1.1 | Создание рейса с указанием типа ВС и бортового номера | `flights.services.planning.create_flight`; тип ВС — по борту `aircraftId` | `POST /flights` | `/flights/new` | `flights/tests/test_api.py::TestPermissions::test_dispatcher_creates_a_flight`, `flights/tests/test_reschedule.py::test_new_conflict_needs_a_reason` (назначение борта) | M4 | реализовано |
| T-3.1.1-02 | 3.1.1 | Маршрут: аэропорты вылета и прилёта | `Flight.dep_icao`, `arr_icao` | `POST /flights` | `/flights/new` | `flights/tests/test_generation.py::TestGenerate::test_generated_flights_carry_the_route`, `flights/tests/test_templates.py::test_template_is_created` | M4 | реализовано |
| T-3.1.1-03 | 3.1.1 | Дата и время по UTC и местному | хранение UTC; на экране UTC с подписью `Z`, в карточке рядом — местное время аэропорта со смещением; ввод времени — в UTC, как подписано поле | `GET /flights/{id}` | карточка рейса | `web/src/shared/format/timezone.test.ts`, `e2e/operations.spec.ts` «время вылета уходит на сервер в UTC, как подписано» (браузер в `Asia/Yekaterinburg`) | M4, M10 | реализовано |
| T-3.1.1-04 | 3.1.1 | Регулярные рейсы: шаблоны повторяющихся маршрутов | `flights.FlightTemplate` | `GET/POST /flight-templates` | `/schedule/templates` | `flights/tests/test_templates.py::test_template_is_created`, `test_default_services_are_created_with_the_template`, `test_impossible_template_is_refused` | M4 | реализовано |
| T-3.1.1-05 | 3.1.1 | Генерация серии рейсов из шаблона | `flights.services.generate_series` | `POST /flight-templates/{id}/generate` | `/schedule/templates` | `flights/tests/test_generation.py::TestGenerate::test_creates_the_expected_number_of_flights`, `TestOccurrences::test_daylight_saving_shifts_utc_within_one_series`, `TestGenerate::test_repeated_generation_does_not_duplicate` | M4 | реализовано |
| T-3.1.1-06 | 3.1.1 | Gantt-диаграмма, интерактивный планшет загрузки парка | `web/modules/schedule/GanttBoard.tsx`, vis-timeline (ADR-015): борта по типам ВС, строка «Без борта», конфликты, линия текущего времени по часам сервера, масштабы сутки / трое суток / неделя | `GET /flights`, `GET /flights/conflicts` | `/schedule` | `e2e/screenshots.spec.ts` `01-schedule-gantt` (1600 и 360 px) | M10 | реализовано |
| T-3.1.1-07 | 3.1.1 | Перетаскивание рейса: время, продолжительность, смена борта | `GanttBoard.tsx`: перенос полосы — вылет, край — прилёт, другая строка — смена борта; при конфликте сервер требует причину, диалог её спрашивает, отказ возвращает полосу | `PATCH /flights/{id}` | `/schedule` | `e2e/schedule.spec.ts` «планшет переносит полосу через сервер (SPEC § 4.1)», 1600 и 360 px — перенос вылета и вопрос о конфликте; край и смена строки испытанием не покрыты | M10 | реализовано |
| T-3.1.1-08 | 3.1.1 | Табличный вид с фильтрацией по дате, борту, статусу, типу рейса | фильтры `SPEC.md § 4.2` на сервере; таблица с пресетами и скрытием колонок (localforage, ADR-015), массовыми действиями | `GET /flights` | `/schedule` | `flights/tests/test_selection.py`, `e2e/schedule.spec.ts` (массовые действия), `e2e/operations.spec.ts` (поиск в таблице) | M4, M10 | реализовано |
| T-3.1.1-09 | 3.1.1 | Подсветка конфликтов расписания | `flights.services.conflicts` | `GET /flights/conflicts` | `/schedule` | `flights/tests/test_conflicts.py::TestOverlap::test_flights_of_one_aircraft_must_not_intersect`, `TestTurnaround::test_too_short_gap_is_a_conflict`, `flights/tests/test_api.py::TestConflictsEndpoint::test_conflicts_are_listed_with_reason_and_severity` | M4 | реализовано |
| T-3.1.2-01 | 3.1.2 | Статус «Запланирован» | автомат, состояние `planned` | `POST /flights/{id}/status` | карточка рейса | `flights/tests/test_transitions.py::TestImpossibleTransitions::test_available_transitions_reflect_the_state`, `core/tests/test_contract_consistency.py::test_initial_state_exists` | M4 | реализовано |
| T-3.1.2-02 | 3.1.2 | Статус «В работе» | состояние `in_work`, guard `start` | `POST /flights/{id}/status` | карточка рейса | `flights/tests/test_transitions.py::TestStart::test_refuses_without_aircraft_and_orders`, `TestStart::test_passes_when_conditions_are_met` | M4 | реализовано |
| T-3.1.2-03 | 3.1.2 | Статус «Готов к вылету»: все услуги подтверждены, разрешения получены | состояние `ready_for_departure`, условия `all_orders_confirmed_or_completed`, `no_rejected_orders`, `permit_confirmed_if_international`. **Не сделано:** условие «разрешения получены» (`permit_confirmed_if_international`) испытанием не покрыто | `POST /flights/{id}/status` | карточка рейса | `flights/tests/test_transitions.py::TestReady::test_unconfirmed_order_blocks_with_a_list_of_reasons`, `TestReady::test_passes_when_every_order_is_confirmed` | M4, M5 | в работе |
| T-3.1.2-04 | 3.1.2 | Статус «В полёте», автоматический переход по факту вылета | `flights.tasks.auto_depart` (Celery Beat, раз в минуту) переводит рейс по **плановому** времени. **Не сделано:** переход по факту вылета — адаптер `TRACK` не написан (M13, `CONNECTING.md § 3`: решение о источнике — OpenSky или FlightAware); испытания задачи `auto_depart` нет | Celery Beat | `/schedule` | ручной вылет — `flights/tests/test_transitions.py::TestDeparture::test_departure_stamps_the_actual_time`; автопереход испытанием не покрыт | M4, M13 | в работе |
| T-3.1.2-05 | 3.1.2 | Статус «Завершён»: услуги выполнены, финдокументы закрыты | состояния `arrived` → `completed` (ADR-009) | `POST /flights/{id}/status` | карточка рейса | `flights/tests/test_transitions.py::TestComplete::test_refused_without_an_invoice`, `TestComplete::test_passes_with_an_issued_invoice`, `TestComplete::test_waiver_with_a_reason_is_audited` | M4, M7 | реализовано |
| T-3.1.2-06 | 3.1.2 | Статус «Отменён» с оповещением заинтересованных сторон | условие `reason_provided`, каскадная отмена открытых заявок их собственным переходом, письма `flight_cancelled` клиенту и `order_cancelled` поставщикам | `POST /flights/{id}/status` | карточка рейса | `flights/tests/test_transitions.py::TestCancel::test_reason_is_mandatory`, `TestEffects::test_cancel_cascades_to_open_orders` | M4, M8 | реализовано |
| T-3.1.2-07 | 3.1.2 | Статус «AOG (задержка)» с автоматическим оповещением | состояние `aog` и переходы в него и из него есть, диспетчеры оповещаются колокольчиком. **Не сделано:** письма клиенту и поставщикам об AOG не отправляются — текстов в наборе шаблонов заказчика нет; эффект `mark_aircraft_aog` не выполняется (G-56) | `POST /flights/{id}/status` | карточка рейса, `/fleet` | `comms/tests/test_events.py::test_flight_status_change_notifies_dispatchers` (любая смена статуса); переход `aog` отдельным испытанием не покрыт | M4 | требует решения (G-56) |
| T-3.1.2-08 | 3.1.2 | Запрет присвоения статуса в обход автомата | `django-fsm-2`, `protected=True`: присвоение поля объекта запрещено. `QuerySet.update()` защиту обходит — граница зафиксирована испытанием, в коде массовых обновлений статуса нет | — | — | `flights/tests/test_transitions.py::TestProtectedField::test_direct_assignment_is_impossible`, `TestProtectedField::test_queryset_update_does_not_go_through_the_machine` | M4 | реализовано |
| T-3.1.3-01 | 3.1.3 | Изменение рейса: время, борт, маршрут | `flights.services.planning`: время, борт, маршрут (`update_route`). **Не сделано:** смена маршрута (`depIcao`, `arrIcao`) испытанием не покрыта | `PATCH /flights/{id}` | карточка рейса | `flights/tests/test_reschedule.py::test_moving_the_bar_keeps_its_length` (время), `test_new_conflict_needs_a_reason` (борт) | M4 | в работе |
| T-3.1.3-02 | 3.1.3 | Автоматическая рассылка уведомлений клиентам при изменении | `comms`, шаблон `flight_rescheduled` | `GET /outbox` | `/communications/outbox` | `flights/tests/test_reschedule.py::test_rescheduling_writes_to_the_client_and_the_vendor` | M8 | реализовано |
| T-3.1.3-03 | 3.1.3 | Автоматическая рассылка уведомлений поставщикам при изменении | `comms`, шаблон `order_changed` | `GET /outbox` | `/communications/outbox` | `flights/tests/test_reschedule.py::test_rescheduling_writes_to_the_client_and_the_vendor` | M8 | реализовано |
| T-3.1.3-04 | 3.1.3 | История изменений по рейсу (аудит-лог) | `audit.AuditEntry`, diff в JSONB | `GET /flights/{id}/history` | вкладка «История» | `flights/tests/test_api.py::TestTransitionEndpoint::test_history_returns_the_audit_trail`, `flights/tests/test_api.py::test_history_includes_the_flight_orders`, `audit/tests/test_audit.py::TestRecord::test_keeps_only_changed_fields` | M3, M4 | реализовано |
| T-3.1.4-01 | 3.1.4 | Панель рейса: данные о клиенте | карточка рейса, вкладка «Обзор» | `GET /flights/{id}` | `/flights/:id/overview` | `e2e/screenshots.spec.ts` `02-flight-card`, `e2e/scenario.spec.ts` | M10 | реализовано |
| T-3.1.4-02 | 3.1.4 | Панель рейса: список заказанных услуг со статусами | вкладка «Услуги» | `GET /flights/{id}/services` | `/flights/:id/services` | `e2e/screenshots.spec.ts` `03-flight-services`, `e2e/scenario.spec.ts` | M10 | реализовано |
| T-3.1.4-03 | 3.1.4 | Панель рейса: информация о поставщиках по каждой услуге | вкладка «Услуги» | `GET /flights/{id}/services` | `/flights/:id/services` | `e2e/screenshots.spec.ts` `03-flight-services`, `e2e/scenario.spec.ts` | M10 | реализовано |
| T-3.1.4-04 | 3.1.4 | Панель рейса: финансовая сводка (доход, расход, маржа) | вкладка «Финансы»: три режима, курс из снимка рядом с суммами | `GET /flights/{id}/margin` | `/flights/:id/finance` | `billing/tests/test_margin.py`, `e2e/scenario.spec.ts` «маржа, аудит и исходящие отражают сценарий» | M7, M10 | реализовано |

---

## Раздел 3.2. Модуль «Управление услугами»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.2.1-01 | 3.2.1 | Единый справочник услуг с группировкой по категориям | `catalog.Service`, `ServiceCategory` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_service_categories_are_exactly_those_in_the_specification` | M3 | реализовано |
| T-3.2.1-02 | 3.2.1 | Топливообеспечение: Jet A-1, Avgas, цены по аэропортам | позиции `FUEL_JETA1`, `FUEL_AVGAS` каталога + `VendorPrice` по ICAO | `GET /catalog/prices` | `/catalog/prices` | `catalog/tests/test_prices_api.py::test_price_is_created_and_listed`, `test_effective_price_is_taken_for_service_date_not_today`, `catalog/tests/test_reference.py::TestSeedReference::test_loads_all_datasets` | M3, M5 | реализовано |
| T-3.2.1-03 | 3.2.1 | Наземное обслуживание: техобслуживание, уборка, трапы, буксировка | позиции категории `handling` в `shared/reference/services.json` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_loads_all_datasets` | M3 | реализовано |
| T-3.2.1-04 | 3.2.1 | Кейтеринг — бортовое питание | позиции категории `catering` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_loads_all_datasets` | M3 | реализовано |
| T-3.2.1-05 | 3.2.1 | Транспорт: автобусы для экипажа и пассажиров, VIP-трансферы | позиции категории `transport` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_loads_all_datasets` | M3 | реализовано |
| T-3.2.1-06 | 3.2.1 | Разрешительные документы: пермиты на пролёт, слоты | категория `permits` + `Slot` (ADR-026) | `GET /slots` | `/slots` | `test_applying_an_answer_moves_the_slot` | M4 | реализовано |
| T-3.2.1-07 | 3.2.1 | Противообледенительная обработка с привязкой к погодным условиям | категория `deicing`; в мастере заказа — неблокирующая подсказка «решение принимает командир ВС» (`orders.services.checks`), правило ADR-029 хранится в настройках (`deicingRule`). **Не сделано:** погоды в системе нет — адаптер `WX` не написан (M13, `CONNECTING.md § 3`: от заказчика ничего не нужно, источник NOAA открытый); правило к подсказке не применяется | `GET /catalog/services` | мастер заказа | хранение правила — `core/tests/test_settings.py::test_impossible_values_are_refused`; применение правила испытанием не покрыто | M5, M13 | в работе |
| T-3.2.1-08 | 3.2.1 | Заказ кейтеринга через специализированные системы | адаптер `VENDOR_API` | `GET /integrations` | `/admin/integrations` | `test_adapter_vendor_api` | M14 | план (без подключения, G-12) |
| T-3.2.2-01 | 3.2.2 | Выбор услуг из каталога при создании рейса | мастер заказа услуги: категория, услуга, обязательные атрибуты, поставщик с результатом проверок | `POST /flights/{id}/services` | `/flights/:id/services` | `orders/tests/test_orders_api.py`, `e2e/scenario.spec.ts` «диспетчер заказывает три услуги у разных поставщиков» | M5, M10 | реализовано |
| T-3.2.2-02 | 3.2.2 | Автопроверка: доступность услуги в аэропорту | `orders.services.checks.availability` | `POST /flights/{id}/services` | мастер заказа | `orders/tests/test_orders_api.py::test_order_in_airport_without_vendors_is_blocked` | M5 | реализовано |
| T-3.2.2-03 | 3.2.2 | Автопроверка: наличие действующего контракта с поставщиком | `orders.services.checks.contract_valid` | `POST /flights/{id}/services` | мастер заказа | `orders/tests/test_orders_api.py::test_order_with_expired_contract_is_blocked` | M5 | реализовано |
| T-3.2.2-04 | 3.2.2 | Автопроверка: актуальность цен и тарифов | `orders.services.checks.price_valid` | `POST /flights/{id}/services` | мастер заказа | `orders/tests/test_orders_api.py::test_order_with_price_expiring_before_service_date_is_blocked` | M5 | реализовано |
| T-3.2.2-05 | 3.2.2 | Автоматическое резервирование: отправка заявки поставщику | переход `order`, письмо в исходящие | `POST /service-orders/{id}/status` | `/communications/outbox` | `test_placing_an_order_puts_a_letter_in_the_outbox` | M5, M8 | реализовано |
| T-3.2.2-06 | 3.2.2 | Подтверждение заявки в системе | портал поставщика: подтверждение и отказ своей заявки; письмо поставщика диспетчер разбирает во «Входящих». **Подключение:** автоматический приём ответов из почты — адаптер `MAILBOT` не написан (M14); от заказчика нужен выделенный ящик с доступом по IMAP (`CONNECTING.md § 3`) | `POST /service-orders/{id}/status` | портал поставщика | `orders/tests/test_orders_api.py::test_vendor_confirms_own_order`, `comms/tests/test_inbox.py::test_apply_moves_the_order_and_records_the_human` | M8, M14 | реализовано (без подключения) |
| T-3.2.3-01 | 3.2.3 | Статус услуги «Заказана» | автомат заявки, `ordered` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `orders/tests/test_sla.py::test_draft_ordered_by_transition_gets_deadline`, `comms/tests/test_events.py::test_placing_an_order_puts_a_letter_in_the_outbox` | M5 | реализовано |
| T-3.2.3-02 | 3.2.3 | Статус «Подтверждена» | `confirmed` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `orders/tests/test_orders_api.py::test_vendor_confirms_own_order` | M5 | реализовано |
| T-3.2.3-03 | 3.2.3 | Статус «В процессе» | `in_progress`, переход `begin` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `orders/tests/test_orders_api.py::test_finish_with_actual_data_completes_order` (`begin` → `finish`) | M5 | реализовано |
| T-3.2.3-04 | 3.2.3 | Статус «Выполнена» | `completed`, создание `PayableItem` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `orders/tests/test_orders_api.py::test_finish_with_actual_data_completes_order`, `billing/tests/test_payables.py::test_payable_appears_when_the_service_is_completed` | M5, M7 | реализовано |
| T-3.2.3-05 | 3.2.3 | Фиксация фактического времени выполнения для биллинга | `actual_start_at`, `actual_end_at` | `PATCH /service-orders/{id}` | `/flights/:id/services` | `orders/tests/test_orders_api.py::test_finish_without_actual_data_is_refused`, `test_finish_with_actual_data_completes_order` | M5 | реализовано |
| T-3.2.3-06 | 3.2.3 | Фактическое количество услуги для биллинга | `actual_quantity` (ADR-020) | `PATCH /service-orders/{id}` | `/flights/:id/services` | `billing/tests/test_documents.py::test_invoice_is_built_from_actual_quantity`, `billing/tests/test_payables.py::test_payable_amount_follows_the_actual_quantity` | M5, M7 | реализовано |
| T-3.2.3-07 | 3.2.3 | Загрузка подтверждающих документов (акты, квитанции) | S3 через presigned URL (ADR-007); для услуг с признаком «нужен акт» заявка без акта не закрывается | `POST /service-orders/{id}/documents` | `/flights/:id/services` | `orders/tests/test_orders_api.py::test_finish_without_act_is_refused_when_act_required`, `core/tests/test_attachments.py::test_reserve_returns_upload_url_and_pending_attachment`, `e2e/scenario.spec.ts` «поставщики отмечают исполнение с фактом и актом» | M5 | реализовано |

---

## Раздел 3.3. Модуль «Управление контрагентами»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.3.1-01 | 3.3.1 | Контактные данные поставщика: адрес, телефон, e-mail, контактное лицо | `counterparties.Vendor`, `Contact` (лицо, роль, e-mail, телефон, язык). **Не сделано:** адреса у поставщика нет — только страна | `GET /vendors/{id}` | `/vendors/:id` | `comms/tests/test_events.py::test_placing_an_order_puts_a_letter_in_the_outbox` (контакт поставщика — адресат заявки), `counterparties/tests/test_counterparties_api.py::test_finance_creates_client_and_sees_it_in_registry` (контакты через API) | M6 | в работе |
| T-3.3.1-02 | 3.3.1 | Специализация: топливо, кейтеринг, хэндлинг, транспорт | `Vendor.specializations`; поставщик чужой категории в подбор не попадает | `GET /vendors` | `/vendors` | `counterparties/tests/test_suggest.py::test_only_vendors_passing_the_order_checks_are_candidates` | M6 | реализовано |
| T-3.3.1-03 | 3.3.1 | География покрытия: аэропорты, регионы | `Vendor.coverage` | `GET /vendors` | `/vendors` | `counterparties/tests/test_counterparties_api.py::test_vendor_is_created_with_coverage_normalised`, `test_vendors_filter_by_airport_coverage` | M6 | реализовано |
| T-3.3.1-04 | 3.3.1 | Условия сотрудничества: цены, отсрочка, валюты расчётов | `VendorPrice`, `PaymentTerms` (ADR-025) | `GET /catalog/prices` | `/vendors/:id` | `billing/tests/test_payables.py::test_due_date_comes_from_the_contract_snapshot`, `test_changing_the_contract_does_not_move_the_due_date`, `catalog/tests/test_prices_api.py::test_price_is_created_and_listed`, `counterparties/tests/test_counterparties_api.py::test_unsupported_currency_is_rejected` | M6 | реализовано |
| T-3.3.1-05 | 3.3.1 | Рейтинг и отзывы (внутренняя оценка качества) | вычисляемый рейтинг `DOMAIN § 7.4`; внутренняя оценка качества — `manualQualityScore` 0–5, входит в формулу. Текстовых отзывов нет | `GET /vendors/{id}/rating` | `/vendors/:id` | `counterparties/tests/test_rating.py::test_fewer_than_five_orders_gives_no_rating`, `test_rating_follows_the_formula`, `test_rating_endpoint_explains_the_number` | M6 | реализовано |
| T-3.3.1-06 | 3.3.1 | Сертификаты и допуски (IATA, ADR и др.) с датами | `VendorCertificate` | `GET /vendors/{id}` | `/vendors/:id` | `counterparties/tests/test_counterparties_api.py::test_vendor_is_created_with_coverage_normalised` (сертификат IATA со сроком) | M6 | реализовано |
| T-3.3.2-01 | 3.3.2 | Ручной выбор поставщика диспетчером | поставщик задаётся в заявке (`orders.services.orders`), замена — отменой и переназначением | `POST /flights/{id}/services`, `POST /service-orders/{id}/reassign` | мастер заказа | `orders/tests/test_orders_api.py::test_order_is_created_with_price_snapshot`, `test_reassignment_creates_new_order_linked_to_rejected_one` | M5 | реализовано |
| T-3.3.2-02 | 3.3.2 | Автовыбор по цене | `vendor_suggest`, пресет весов 1/0/0 | `POST /vendors/suggest` | сравнение кандидатов | `counterparties/tests/test_suggest.py::test_price_mode_puts_the_cheapest_first` | M6 | реализовано |
| T-3.3.2-03 | 3.3.2 | Автовыбор по рейтингу | пресет 0/1/0 | `POST /vendors/suggest` | сравнение кандидатов | `counterparties/tests/test_suggest.py::test_rating_mode_follows_the_rating` | M6 | реализовано |
| T-3.3.2-04 | 3.3.2 | Автовыбор по географической близости | пресет 0/0/1, гаверсинус | `POST /vendors/suggest` | сравнение кандидатов | `counterparties/tests/test_suggest.py::test_proximity_mode_prefers_a_base_at_the_airport` | M6 | реализовано |
| T-3.3.2-05 | 3.3.2 | Автоматическая фиксация закупочной цены при назначении | снимок цены (`CLAUDE.md § 3` п. 5) | `POST /flights/{id}/services` | — | `orders/tests/test_orders_api.py::test_order_is_created_with_price_snapshot`, `test_price_change_does_not_rewrite_placed_order` | M5 | реализовано |
| T-3.3.3-01 | 3.3.3 | Ведение сроков действия договоров с поставщиками | `counterparties.VendorContract` | `GET /contracts` | `/contracts` | `counterparties/tests/test_counterparties_api.py::test_contract_is_created_and_listed`, `test_contract_expiring_within_30_days_shows_warning_status`, `test_expired_contract_is_reported_as_expired` | M6 | реализовано |
| T-3.3.3-02 | 3.3.3 | Автоуведомление об истечении за 30, 15, 7 дней | `contracts.check_expiry` + `dedupe_key` | `GET /notifications` | `/contracts` | `counterparties/tests/test_expiry.py::test_shift_by_25_days_gives_one_reminder_per_threshold`, `test_next_threshold_fires_later_and_only_once` | M6 | реализовано |

---

## Раздел 3.4. Модуль «Финансовые условия и взаиморасчёты»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.4.1-01 | 3.4.1 | Предоплата / постоплата / отсрочка платежа для клиента | `Client` с условиями оплаты: режим (предоплата / постоплата / отсрочка), дни отсрочки; срок оплаты счёта — по дням отсрочки. **Не сделано:** режимы «предоплата» и «постоплата» на расчёты не влияют — предоплата не выставляется и не проверяется до вылета | `GET /clients/{id}` | `/clients/:id` | `counterparties/tests/test_counterparties_api.py::test_finance_creates_client_and_sees_it_in_registry`, `test_deferred_terms_without_days_are_rejected`, `billing/tests/test_documents.py::test_issuing_assigns_number_and_due_date` | M6 | в работе |
| T-3.4.1-02 | 3.4.1 | Валюты расчётов USD, EUR, RUB | `CurrencyCode`, `FxSnapshot` (ADR-004); курсы — ЦБ РФ, подключение `FX` работает | `GET /fx-rates` | `/billing/fx` | `core/tests/test_money.py::test_convert_cross_currency_goes_through_base`, `test_unsupported_currency_rejected`, `integrations/tests/test_fx.py::TestSnapshot::test_rates_are_decimal_strings` | M7 | реализовано |
| T-3.4.1-03 | 3.4.1 | Скидки и наценки в процентах или фиксированной сумме | `TariffRule`: наценка в процентах (`cost_plus`), фиксированная цена продажи (`fixed`), скидка процентом или суммой. **Не сделано:** наценки фиксированной суммой нет (есть фиксированная цена); скидка суммой испытанием не покрыта | `GET /clients/{id}/tariffs` | `/clients/:id` | `billing/tests/test_tariffs.py::test_same_service_costs_differently_for_two_clients`, `test_given_purchase_price_is_used_and_discount_is_explained` | M7 | в работе |
| T-3.4.1-04 | 3.4.1 | Автоматический расчёт: сумма услуг по ценам клиента | `billing.services.pricing` | `GET /flights/{id}/margin` | `/flights/:id/finance` | `billing/tests/test_tariffs.py::test_same_service_costs_differently_for_two_clients`, `test_most_specific_rule_wins_and_the_reason_is_shown`, `test_equal_priority_prefers_the_later_rule` | M7 | реализовано |
| T-3.4.1-05 | 3.4.1 | Автоматический расчёт: транспортные сборы и комиссии | поле сборов документа (`fees`, `fees_amount`) входит в итог и маржу (ADR-023). **Не сделано:** сборы и комиссии нигде не задаются — справочника сборов клиента нет, при формировании документа итог сборов всегда 0 | `POST /quotes` | котировка | испытания нет | M7 | в работе |
| T-3.4.1-06 | 3.4.1 | Итоговая стоимость в выбранной валюте | документ строится в валюте расчётов рейса, курс фиксируется в документе. **Не сделано:** испытания документа в валюте, отличной от валюты закупки, нет | `GET /quotes/{id}` | котировка | `billing/tests/test_documents.py::test_invoice_is_built_from_actual_quantity` (снимок курса в документе) | M7 | в работе |
| T-3.4.1-07 | 3.4.1 | Формирование коммерческого предложения (Quote) до вылета | `billing.Quote` | `POST /quotes`, `/quotes/{id}/issue` | `/billing/quotes` | `billing/tests/test_documents.py::test_quote_includes_planned_services`, `test_quote_accepted_by_client` | M7 | реализовано |
| T-3.4.1-08 | 3.4.1 | Выгрузка котировки в PDF и Excel | WeasyPrint, openpyxl; выгрузка есть у счёта. **Не сделано:** у котировки нет эндпоинта и кнопки выгрузки — сервис `export_document` котировку формирует, но не вызывается | `POST /invoices/{id}/export` (у котировки нет) | `/billing/quotes` | счёт — `billing/tests/test_export.py::test_pdf_is_a_real_pdf_with_the_same_total`, `test_xlsx_carries_the_same_grand_total`; котировка не выгружается | M7 | в работе |
| T-3.4.1-09 | 3.4.1 | Автоматическое создание счёта после рейса по фактически оказанным услугам | `billing.services.documents.build_invoice`: строки и суммы — из факта (`actual_quantity`), сопоставление «план ↔ факт»; счёт формирует финансист действием на рейсе (`SPEC § 7.2`) | `POST /invoices` | `/billing/invoices` | `billing/tests/test_documents.py::test_invoice_is_built_from_actual_quantity`, `test_invoice_without_completed_services_is_refused`, `test_plan_fact_comparison_explains_the_difference` | M7 | реализовано |
| T-3.4.1-10 | 3.4.1 | Сквозная нумерация документов без дыр | `DocumentCounter` + `select_for_update` | — | — | `billing/tests/test_documents.py::test_numbering_has_no_gaps_under_concurrency` | M7 | реализовано |
| T-3.4.1-11 | 3.4.1 | Учёт поступивших платежей и статус оплаты счёта | `billing.Payment` (ADR-019) | `GET/POST /payments` | `/billing/invoices` | `billing/tests/test_payments.py::test_full_payment_makes_the_invoice_paid`, `test_partial_payment_makes_it_partially_paid` | M7 | реализовано |
| T-3.4.2-01 | 3.4.2 | Фиксация закупочной цены каждой услуги | снимок в `ServiceOrder` | — | `/flights/:id/services` | `orders/tests/test_orders_api.py::test_order_is_created_with_price_snapshot`, `test_price_change_does_not_rewrite_placed_order` | M5 | реализовано |
| T-3.4.2-02 | 3.4.2 | Автоформирование заявок на оплату по факту выполнения | `PayableItem` при переходе `finish` | `GET /payables` | `/billing/payables` | `billing/tests/test_payables.py::test_payable_appears_when_the_service_is_completed`, `test_payable_is_created_once` | M7 | реализовано |
| T-3.4.2-03 | 3.4.2 | Контроль сроков оплаты с учётом отсрочки | `due_date` из снимка условий контракта | `GET /payables` | `/billing/payables` | `billing/tests/test_payables.py::test_due_date_comes_from_the_contract_snapshot`, `test_overdue_is_computed_by_the_server`, `billing/tests/test_payments.py::test_overdue_invoice_and_payable_notify_once` | M7 | реализовано |
| T-3.4.2-04 | 3.4.2 | Сверка счетов поставщиков с заказанными услугами | `billing.services.reconciliation` | `POST /reconciliation/import` | `/billing/reconciliation` | `billing/tests/test_reconciliation.py::test_price_difference_is_a_discrepancy`, `test_line_without_our_order_is_missing_on_our_side`, `test_our_order_without_their_line_is_missing_on_their_side`, `test_filled_template_is_imported_and_reconciled` | M7 | реализовано |
| T-3.4.2-05 | 3.4.2 | Автоматическое выявление расхождений | алгоритм `DOMAIN § 7.7`, допуск 0.01 | `GET /reconciliation/{id}` | `/billing/reconciliation` | `billing/tests/test_reconciliation.py::test_rounding_difference_is_not_a_discrepancy`, `test_quantity_difference_is_named_by_quantity`, `test_date_window_of_one_day_still_matches` | M7 | реализовано |
| T-3.4.2-06 | 3.4.2 | Сопоставление номенклатуры поставщика с каталогом | `VendorServiceMapping` (ADR-024) | `GET /vendor-service-mappings` | `/billing/reconciliation` | `billing/tests/test_reconciliation.py::test_unknown_vendor_code_goes_to_the_mapping_queue`, `test_mapping_makes_the_code_match`, `test_mapping_can_be_added_through_the_api` | M7 | реализовано |
| T-3.4.3-01 | 3.4.3 | Маржинальность рейса в реальном времени | `billing.services.margin`, кэш Redis | `GET /flights/{id}/margin` | `/flights/:id/finance` | `billing/tests/test_margin.py::test_plan_takes_everything_but_cancelled_and_rejected`, `test_cache_is_reset_when_orders_change`, `reports/tests/test_dashboards.py::test_aggregate_path_matches_the_canonical_margin_to_the_kopeck` | M7 | реализовано |
| T-3.4.3-02 | 3.4.3 | Доход от клиента (сумма счёта) | режим `fact` | `GET /flights/{id}/margin` | `/flights/:id/finance` | `billing/tests/test_margin.py::test_fact_uses_the_actual_quantity_and_the_invoice` | M7 | реализовано |
| T-3.4.3-03 | 3.4.3 | Расход на поставщиков (сумма заявок на оплату) | режим `fact` | `GET /flights/{id}/margin` | `/flights/:id/finance` | `billing/tests/test_margin.py::test_fact_takes_only_completed_by_their_actuals` | M7 | реализовано |
| T-3.4.3-04 | 3.4.3 | Маржа в валюте и процентах | `margin`, `marginPct` (null при нулевой выручке) | `GET /flights/{id}/margin` | `/flights/:id/finance` | `billing/tests/test_margin.py::test_zero_revenue_gives_no_percent`, `test_negative_margin_is_shown_not_zeroed` | M7 | реализовано |
| T-3.4.3-05 | 3.4.3 | Оперативная замена поставщика при низкой марже | порог с уведомлением; в карточке — предупреждение с действием «Подобрать более дешёвого поставщика», ведущим к услугам рейса, где у каждой заявки сравнение кандидатов с влиянием на маржу; замена — отменой и переназначением | `POST /vendors/suggest`, `POST /service-orders/{id}/reassign` | `/flights/:id/services` | `billing/tests/test_margin.py::test_low_margin_notifies_once`, `counterparties/tests/test_suggest.py::test_margin_impact_follows_the_clients_tariff`, `e2e/scenario.spec.ts` «поставщик отказывает, диспетчер переназначает» | M7, M10 | реализовано |

---

## Раздел 3.5. Модуль «Коммуникации и уведомления»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.5.1-01 | 3.5.1 | Оповещение диспетчеров об изменении статуса рейса | `comms.Notification` kind `flight_status` | `GET /notifications` | колокольчик | `test_flight_status_change_notifies_dispatchers` | M8 | реализовано |
| T-3.5.1-02 | 3.5.1 | Оповещение о подтверждении или отказе услуги поставщиком | kind `service_confirmed`, `service_rejected` | `GET /notifications` | колокольчик | `test_confirmation_notifies_the_dispatchers` | M8 | реализовано |
| T-3.5.1-03 | 3.5.1 | Оповещение о приближении дедлайнов | заранее — об истечении договора за 30, 15 и 7 дней; по факту — просрочка оплаты и нарушение SLA. **Не сделано:** вид `deadline` объявлен, но не создаётся: заранее о сроке подтверждения, исполнения заявки и оплаты не оповещают | `GET /notifications` | колокольчик | `counterparties/tests/test_expiry.py::test_shift_by_25_days_gives_one_reminder_per_threshold`, `billing/tests/test_payments.py::test_overdue_invoice_and_payable_notify_once`, `orders/tests/test_sla.py::test_overdue_order_is_marked_once` | M8 | в работе |
| T-3.5.1-04 | 3.5.1 | Интеграция с корпоративным мессенджером MAX | адаптер `MSGR` | `GET /integrations` | `/admin/integrations` | `test_adapter_msgr` | M14 | требует решения (G-04) |
| T-3.5.1-05 | 3.5.1 | Интеграция с e-mail как альтернатива мессенджеру | адаптер `SMTP` | `GET /outbox` | `/communications/outbox` | `test_accepted_letter_is_sent_but_not_delivered` | M13 | реализовано |
| T-3.5.2-01 | 3.5.2 | Рассылка клиентам: подтверждение рейса | шаблон `flight_confirmed` | `GET /outbox` | `/communications/templates` | `test_reference_carries_every_required_template` | M8 | реализовано |
| T-3.5.2-02 | 3.5.2 | Рассылка клиентам: изменения в расписании | шаблон `flight_rescheduled` | `GET /outbox` | `/communications/templates` | `test_reference_carries_every_required_template` | M8 | реализовано |
| T-3.5.2-03 | 3.5.2 | Рассылка клиентам: счёт и закрывающие документы | шаблоны `invoice_issued`, `closing_documents` | `GET /outbox` | `/communications/templates` | `test_issued_invoice_goes_to_the_client` | M8 | реализовано |
| T-3.5.2-04 | 3.5.2 | Рассылка поставщикам: заявки на услуги | шаблон `order_placed` | `GET /outbox` | `/communications/templates` | `test_placing_an_order_puts_a_letter_in_the_outbox` | M8 | реализовано |
| T-3.5.2-05 | 3.5.2 | Рассылка поставщикам: напоминания о сроках исполнения | шаблон `order_deadline_reminder` есть в справочнике. **Не сделано:** задачи, которая рассылает напоминания поставщикам, нет | `GET /outbox` | `/communications/templates` | наличие шаблона — `comms/tests/test_templates.py::test_reference_carries_every_required_template`; рассылка не реализована | M8 | в работе |
| T-3.5.2-06 | 3.5.2 | Язык письма по локали получателя | версии шаблона ru/en | `GET /outbox` | `/communications/templates` | `test_letter_language_follows_the_contact` | M8 | реализовано |
| T-3.5.3-01 | 3.5.3 | Портал клиента: заказ рейсов самостоятельно | заявка на рейс из портала → очередь диспетчера, рейс создаётся только его решением. Обязательность портала ждёт ответа заказчика (G-05); до ответа портал реализован | `POST /portal/client/flight-requests` | портал клиента | `portals/tests/test_portals.py::test_request_becomes_a_flight_only_after_the_dispatcher`, `test_impossible_request_is_refused` | M8 | реализовано |
| T-3.5.3-02 | 3.5.3 | Портал клиента: заказ рейсов по шаблонам | заявка по шаблону рейса клиента; чужой шаблон отклоняется. **Не сделано:** заявка по своему шаблону испытанием не покрыта. Обязательность портала ждёт ответа заказчика (G-05); до ответа портал реализован | `POST /portal/client/flight-requests` | портал клиента | `portals/tests/test_portals.py::test_foreign_template_is_refused` | M8 | в работе |
| T-3.5.3-03 | 3.5.3 | Портал клиента: отслеживание статусов рейсов и услуг | фильтр арендатора; статусы рейсов и услуг без закупочных цен и поставщиков. Обязательность портала ждёт ответа заказчика (G-05); до ответа портал реализован | `GET /portal/client/flights` | портал клиента | `portals/tests/test_portals.py::test_client_sees_only_own_flights`, `test_client_portal_carries_no_purchase_prices_or_vendors`, `test_rejected_order_is_not_shown_to_the_client` | M8 | реализовано |
| T-3.5.3-04 | 3.5.3 | Портал клиента: история заказов и финансовые документы | выставленные котировки и счета клиента, черновики не показываются. Обязательность портала ждёт ответа заказчика (G-05); до ответа портал реализован | `GET /portal/client/documents` | портал клиента | `portals/tests/test_portals.py::test_documents_show_issued_not_drafts_and_only_own` | M8 | реализовано |
| T-3.5.3-05 | 3.5.3 | Портал клиента: принятие или отклонение котировки | ADR-030: принятие и отклонение выставленной котировки клиентом. Обязательность портала ждёт ответа заказчика (G-05); до ответа портал реализован | `POST /quotes/{id}/accept` | портал клиента | `billing/tests/test_documents.py::test_quote_accepted_by_client` | M8 | реализовано |

---

## Раздел 3.6. Модуль «Отчётность и аналитика»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.6.1-01 | 3.6.1 | Суточный, недельный, месячный отчёт по рейсам | отчёт `flights_period` | `GET /reports/flights_period` | `/reports/:code` | `test_flights_period_counts_services_of_the_flight` | M9 | реализовано |
| T-3.6.1-02 | 3.6.1 | Отчёт по оказанным услугам с группировкой по типу | отчёт `services_rendered` | `GET /reports/services_rendered` | `/reports/:code` | `test_services_rendered_shows_actual_quantity_and_purchase_cost` | M9 | реализовано |
| T-3.6.1-03 | 3.6.1 | Финансовый отчёт: доходы, расходы, маржинальность | отчёт `financial` | `GET /reports/financial` | `/reports/:code` | `test_financial_margin_is_revenue_minus_cost` | M9 | реализовано |
| T-3.6.1-04 | 3.6.1 | Отчёт по поставщикам: объём заказов, качество, задержки | отчёт `vendors` | `GET /reports/vendors` | `/reports/:code` | `test_vendors_report_counts_orders_and_sla_breaches` | M9 | реализовано |
| T-3.6.1-05 | 3.6.1 | Отчёт по дебиторской и кредиторской задолженности | отчёт `receivables_payables` | `GET /reports/receivables_payables` | `/reports/:code` | `test_receivables_show_issued_unpaid_invoice_with_bucket` | M9 | реализовано |
| T-3.6.1-06 | 3.6.1 | Реестр нарушений SLA | отчёт `sla_breaches` | `GET /reports/sla_breaches` | `/reports/:code` | `test_sla_register_lists_only_breached_orders` | M9 | реализовано |
| T-3.6.1-07 | 3.6.1 | Журнал изменений рейсов за период | отчёт `flight_audit` | `GET /reports/flight_audit` | `/reports/:code` | `test_flight_audit_shows_status_changes` | M9 | реализовано |
| T-3.6.2-01 | 3.6.2 | Дашборд диспетчера: текущий статус рейсов, критические задержки | `reports.dashboards.dispatcher` | `GET /dashboards/dispatcher` | `/dashboards/dispatcher` | `reports/tests/test_dashboards.py::test_dispatcher_dashboard_shows_the_current_situation`, `test_finance_has_no_dispatcher_dashboard` | M9 | реализовано |
| T-3.6.2-02 | 3.6.2 | Дашборд руководителя: количество рейсов, загрузка, маржинальность по клиентам | `reports.dashboards.manager` | `GET /dashboards/manager` | `/dashboards/manager` | `reports/tests/test_dashboards.py::test_manager_dashboard_reads_the_refreshed_aggregates`, `test_dispatcher_has_no_manager_dashboard` | M9 | реализовано |
| T-3.6.2-03 | 3.6.2 | Настройка виджетов под роль пользователя | раскладка на пользователя: добавление, удаление, порядок и размер виджетов в режиме правки | `PUT /dashboards/{role}/layout` | дашборды | `reports/tests/test_dashboards.py::test_layout_is_saved_per_user`, `test_impossible_layout_is_refused` | M9, M10 | реализовано |
| T-3.6.3-01 | 3.6.3 | Выгрузка отчётов в PDF | WeasyPrint | `POST /reports/{code}/export` | `/reports/:code` | `test_pdf_is_produced` | M9 | реализовано |
| T-3.6.3-02 | 3.6.3 | Выгрузка отчётов в Excel (XLSX) | openpyxl | `POST /reports/{code}/export` | `/reports/:code` | `test_xlsx_money_cells_are_numbers` | M9 | реализовано |
| T-3.6.3-03 | 3.6.3 | Выгрузка отчётов в CSV | стандартный `csv` | `POST /reports/{code}/export` | `/reports/:code` | `test_csv_carries_the_same_numbers_as_the_report` | M9 | реализовано |
| T-3.6.3-04 | 3.6.3 | Выгрузка отчётов в XML | схема `soc-report-v1.xsd` (ADR-032) | `POST /reports/{code}/export` | `/reports/:code` | `test_xml_validates_against_soc_report_xsd` | M9 | реализовано |
| T-3.6.3-05 | 3.6.3 | Отправка отчётов по e-mail по расписанию | подписки + задача `reports.scheduled` | `GET/POST /report-subscriptions` | `/reports` | `test_subscription_produces_a_letter_with_the_report_attached` | M9 | реализовано |

---

## Раздел 4. Технические требования

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-4.1-01 | 4.1 | Веб-приложение как основной интерфейс | React 18 + Vite + Ant Design, все экраны на настоящем API; PWA; вёрстка от 360 px | — | все | `e2e/` целиком в профилях 1600 и 360 px, `e2e/screenshots.spec.ts` (46 экранов без ошибок консоли и горизонтального скролла) | M10 | реализовано |
| T-4.1-02 | 4.1 | Мобильное приложение Android | Expo, EAS Build (ADR-006) | — | мобильные экраны | Maestro + установка на устройство | M12 | план |
| T-4.1-03 | 4.1 | Мобильное приложение iOS | Expo, TestFlight (ADR-006) | — | мобильные экраны | Maestro + TestFlight | M12 | план |
| T-4.1-04 | 4.1 | Профиль «полевой персонал» | профиль диспетчера с урезанными правами | `/auth/me` | мобильные экраны | `test_permissions_field_staff` | M12 | требует решения (G-50) |
| T-4.1-05 | 4.1 | SaaS-архитектура | `Organization` + `TenantScopedMixin` (ADR-003) | все | — | `tests/test_tenant_isolation.py` | M3 | реализовано |
| T-4.1-06 | 4.1 | Развёртывание on-premise | тот же набор образов, другая конфигурация | — | — | развёртывание на чистой машине | M1, M17 | план |
| T-4.1-07 | 4.1 | Клиент-серверная архитектура (Windows-сервис) | контейнеры Linux, в том числе на сервере Windows | — | — | — | — | требует решения (G-02) |
| T-4.1-08 | 4.1 | БД PostgreSQL | PostgreSQL 16 (ADR-001) | — | — | схема создаётся миграциями с нуля: тестовая база каждого прогона pytest (`artifacts/traceability/2026-10-28-pytest.txt`), `manage.py migrate` на пустой базе стенда (`artifacts/traceability/2026-10-28-stand-init.txt`) | M1 | реализовано |
| T-4.1-09 | 4.1 | БД MSSQL | не реализуется (ADR-001) | — | — | — | — | требует решения (G-01) |
| T-4.1-10 | 4.1 | Кластеризация для отказоустойчивости | реплика с ручным переключением (ADR-001, `INFRA § 7`) | — | — | испытание переключения | M15 | план |
| T-4.2-01 | 4.2 | REST API для интеграции с внешними системами | DRF + `openapi.yaml`, `/api/v1`; сверка схемы — `make api-schema`, `core/tests/test_contract_consistency.py`. **Не сделано:** контрактный прогон `schemathesis` не настроен | все | `/api-docs` | `core/tests/test_contract_consistency.py::test_contract_is_openapi_31`, `test_money_amount_is_string_not_number`; `schemathesis` не запускается | M1–M15 | в работе |
| T-4.2-02 | 4.2 | Интеграция с 1С: счета, платежи, списания | адаптер `ONEC` (OData) | `POST /integrations/ONEC/test` | `/admin/integrations` | `test_adapter_onec_cassette` | M14 | план (без подключения до доступа) |
| T-4.2-03 | 4.2 | Системы аэропортов: слоты | реестр слотов, черновик SCR и разбор ответа (ADR-026) | `GET /slots` | `/slots` | `test_scr_carries_the_slot_details` | M14 | реализовано (формат сверяется с образцами заказчика, G-34) |
| T-4.2-04 | 4.2 | Системы аэропортов: статус обслуживания | ведётся вручную в реестре поставщиков | — | `/vendors/:id` | — | M6 | вне объёма (нет источника) |
| T-4.2-05 | 4.2 | Системы поставщиков: обмен заявками и подтверждениями | портал поставщика и исходящие письма-заявки работают. **Не сделано (M14):** адаптеры `MAILBOT` (приём ответов по IMAP) и `VENDOR_API` не написаны (`CONNECTING.md § 3`) | `/portal/vendor/*` | портал поставщика | `portals/tests/test_portals.py::test_vendor_sees_own_sent_orders_without_the_sale_price`, `comms/tests/test_events.py::test_placing_an_order_puts_a_letter_in_the_outbox` | M8, M14 | в работе |
| T-4.2-06 | 4.2 | IATA BDG для стандартизации биллинговых данных | выгрузка IS-XML (ADR-032) | `POST /reports/{code}/export` | `/reports` | `test_export_isxml` | M14 | требует решения (G-03) |
| T-4.2-07 | 4.2 | Импорт/экспорт через ODBC-драйверы | реплика только для чтения + представления (ADR-005) | — | — | подключение DBeaver по ODBC | M13 | требует согласования (G-49) |
| T-4.2-08 | 4.2 | Интеграция с Power BI | те же представления | — | — | построение отчёта в Power BI | M13 | план |
| T-4.2-09 | 4.2 | Интеграция с Tableau | те же представления | — | — | подключение Tableau | M13 | план |
| T-4.3-01 | 4.3 | Аутентификация LDAP / Active Directory | адаптер `LDAP`, `django-auth-ldap` | `POST /auth/login` | `/login` | `test_adapter_ldap`, `test_ldap_group_to_role` | M3, M14 | план (без подключения до доступа) |
| T-4.3-02 | 4.3 | Двухфакторная аутентификация | TOTP `pyotp`, резервные коды (ADR-013) | `POST /auth/2fa` | `/login` | `accounts/tests/test_auth.py::TestTwoFactor`, `e2e/helpers/session.ts` | M3 | реализовано |
| T-4.3-03 | 4.3 | Ролевая модель доступа: 6 ролей ТЗ | карта `role → permission`, единая с клиентом | `GET /auth/me` | `/admin/users` | `tests/test_permissions.py`, `tests/test_permission_map.py` | M3 | реализовано |
| T-4.3-04 | 4.3 | Проверка прав на сервере в каждом эндпоинте | `HasRolePermission`: действие без объявленного права запрещено | все | — | `tests/test_permissions.py::TestEndpointPermissions` | M3 | реализовано |
| T-4.3-05 | 4.3 | Изоляция данных порталов | `TenantScopedViewSet`, 404 вместо 403. **Не сделано:** нет теста на протечку для `GET /quotes` под ролью клиента (`CLAUDE.md § 3` п. 11) | портальные | порталы | `tests/test_tenant_isolation.py`, `portals/tests/test_portals.py` (шесть портальных эндпоинтов), `billing/tests/test_documents.py::test_client_sees_only_own_invoices`, `billing/tests/test_payments.py::test_client_sees_only_own_payments`, `billing/tests/test_payables.py::test_vendor_sees_only_own_payables`, `orders/tests/test_orders_api.py::test_vendor_sees_only_own_orders`, `fleet/tests/test_fleet_create.py::test_client_sees_only_own_aircraft` | M3, M8 | в работе |
| T-4.3-06 | 4.3 | Логирование изменения статуса рейса | `audit` | `GET /audit` | `/admin/audit` | `flights/tests/test_transitions.py::TestStart::test_transition_is_recorded_in_audit`, `TestCancel::test_reason_is_stored_and_audited` | M3, M4 | реализовано |
| T-4.3-07 | 4.3 | Логирование замены поставщика | `audit`: `vendor_assigned`, `reassigned` (`orders.services.orders`) | `GET /audit` | `/admin/audit` | `e2e/scenario.spec.ts` «маржа, аудит и исходящие отражают сценарий» (в истории рейса — «Поставщик переназначен») | M3, M5 | реализовано |
| T-4.3-08 | 4.3 | Логирование выставления счёта | запись `issued` в журнал пишет `billing.services.documents.issue_invoice`. **Не сделано:** испытания, что выставление счёта попадает в журнал, нет | `GET /audit` | `/admin/audit` | испытания нет; аннулирование — `billing/tests/test_documents.py::test_voiding_requires_reason_and_writes_it_to_audit` | M3, M7 | в работе |
| T-4.3-09 | 4.3 | Неизменяемость записей аудита | триггер `audit_entry_append_only` (ADR-033) | `GET /audit` | `/admin/audit` | `audit/tests/test_audit.py::TestImmutability` | M3 | реализовано |
| T-4.3-10 | 4.3 | Защита персональных данных экипажа (152-ФЗ) | `flights.CrewMember` (ADR-028), пассажиры поимённо не хранятся, срок хранения ПДн — настройка `pdRetentionMonths`. **Не сделано:** экипаж отдаётся в карточке рейса всем, кто её читает; обращения к ПДн не журналируются; обезличивания по сроку нет | `GET /crew` | карточка рейса | испытания нет | M3, M4 | в работе |
| T-4.3-11 | 4.3 | Единый визуальный язык интерфейса | дизайн-система «Streamline SOC» v2: токены в `theme.ts` и `status-tokens.ts`, знак в обвязке (ADR-035) | — | все экраны | `status-tokens.test.ts` (контраст восьми пар ≥ 4.5:1), `e2e/screenshots.spec.ts` | M4 | реализовано |
| T-4.3-12 | 4.3 | Навигация по разделам системы | рельс из девяти пунктов в трёх группах, экраны раздела — вкладками | — | все экраны | `navigation.test.ts`, `e2e/screenshots.spec.ts` | M4 | реализовано |
| T-4.3-13 | 4.3 | Смена сотрудника без обхода аутентификации | `GET /auth/accounts` подставляет логин, вход настоящий (ADR-013, ADR-036) | `GET /auth/accounts` | `/login` | `accounts/tests/test_accounts_list.py` | M4 | реализовано |
| T-4.3-14 | 4.3 | Самостоятельная регистрация заказчика | подтверждение почты, затем карточка и учётная запись без участия человека (ADR-037) | `POST /auth/register`, `POST /auth/register/confirm` | `/login` | `accounts/tests/test_registration.py`, `e2e/registration.spec.ts` | M4 | реализовано |
| T-4.3-15 | 4.3 | Заявка поставщика на согласование | очередь администратора (право `admin`), одобрение заводит карточку и доступ, отказ — с причиной (ADR-037) | `GET /registration-requests`, `POST /registration-requests/{id}/approve`, `.../reject` | `/admin/registrations` | `accounts/tests/test_registration.py::test_approval_creates_the_vendor_and_the_account`, `test_rejection_creates_nothing`, `test_dispatcher_cannot_decide` | M4 | реализовано |
| T-4.3-16 | 4.3 | Подтверждение адреса почты при регистрации | одноразовая ссылка, в базе хэш; письмо уходит через общую очередь исходящих адаптером `SMTP` (в демонстрационной установке — в почтовый сервер установки) | `POST /auth/register/confirm` | `/register/confirm` | `accounts/tests/test_registration.py::test_the_link_works_once`, `test_wrong_token_confirms_nothing` | M4 | реализовано |
| T-4.4-01 | 4.4 | Одновременная работа до 50 пользователей без деградации | — | — | — | k6, профиль 50 VU, 15 мин | M15 | план |
| T-4.4-02 | 4.4 | Открытие карточки рейса не более 2 секунд | — | `GET /flights/{id}` | `/flights/:id` | k6 `p95 < 2000` + LCP (ADR-017); браузерный замер без нагрузки — `e2e/perf.spec.ts`, протокол в `artifacts/perf/` | M10, M15 | в работе |
| T-4.4-03 | 4.4 | Расчёт маржинальности не более 5 секунд | кэш Redis, чистая функция | `GET /flights/{id}/margin` | `/flights/:id/finance` | k6 `p95 < 5000` | M15 | план |
| T-4.4-04 | 4.4 | Восстановление после сбоя не более 30 минут | pgBackRest, инструкция администратора | — | — | учебное восстановление с хронометражом | M15 | план |
| T-4.4-05 | 4.4 | Резервное копирование ежедневно | pgBackRest: полная еженедельно, инкрементальная ежедневно, WAL непрерывно | — | — | журнал заданий | M15, M16 | план |
| T-4.4-06 | 4.4 | Хранение резервных копий 30 дней | политика хранения pgBackRest | — | — | проверка политики | M15 | план |
| T-4.5-01 | 4.5 | Интерфейс на русском языке | `i18next`, `ru`; в компонентах нет русского текста вне `t()` | — | все | `web/src/shared/i18n/no-hardcoded-text.test.ts` | M1, M10 | реализовано |
| T-4.5-02 | 4.5 | Интерфейс на английском языке | `i18next`, `en` | — | все | `web/src/shared/i18n/i18n.test.ts` (ключи ru и en совпадают, пустых нет) | M1, M10 | реализовано |
| T-4.5-03 | 4.5 | Наименования справочников на двух языках | `name_ru` / `name_en` (ADR-031) | справочные | справочники | `catalog/tests/test_reference.py::test_verified_airports_have_russian_names` | M3 | реализовано |
| T-4.5-04 | 4.5 | Отображение данных в разных часовых поясах (UTC / локальное) | обязательная подпись зоны; UTC везде, местное время аэропорта в карточке рейса, зона пользователя в часах шапки. **Не сделано:** экраны не переключаются по настройке пользователя `timezoneMode` — она хранится, но не применяется | — | все | `web/src/shared/format/timezone.test.ts` | M10 | в работе |

---

## Разделы 5–7. Этапы, поставка, поддержка

| ID | Пункт | Требование | Реализация | Тест / подтверждение | Веха | Статус |
|---|---|---|---|---|---|---|
| T-5-01 | 5, этап 1 | Утверждённый протокол требований | `GAPS.md`, `DECISIONS.md`, `openapi.yaml`, письмо заказчику | подпись заказчика | M0 | в работе |
| T-5-02 | 5, этап 2 | Кликабельные макеты для утверждения | веб-клиент на статических данных | утверждение заказчиком, скриншоты в `artifacts/screenshots/m2/` | M2 | план |
| T-5-03 | 5, этап 3 | Рабочее ядро системы | M3–M10 | `make check` зелёный, сквозной сценарий `e2e/scenario.spec.ts`; остатки M7 и M9 — `TASKS.md` | M3–M10 | в работе |
| T-5-04 | 5, этап 4 | Мобильные клиенты | M12 | установка на устройства | M12 | план |
| T-5-05 | 5, этап 5 | Пройдены тесты стыковки | M13, M14 | тесты адаптеров, кассеты | M13, M14 | план |
| T-5-06 | 5, этап 6 | Отчёт о тестировании | M15 | отчёты инструментов в `artifacts/` | M15 | план |
| T-5-07 | 5, этап 7 | Акт об успешной опытной эксплуатации | M16 | пилот на 5–10 рейсах с сотрудниками заказчика | M16 | план |
| T-5-08 | 5, этап 8 | Система в промышленной эксплуатации | M17 | акт ввода | M17 | план |
| T-6-01 | 6 | Серверное ПО | образы и исходники | передача по договору | M17 | план |
| T-6-02 | 6 | Клиентские лицензии по числу рабочих мест | механизм не реализуется | — | — | требует решения (G-08) |
| T-6-03 | 6 | Интеграционный адаптер к 1С | `integrations/onec` | `test_adapter_onec_cassette` | M14 | план |
| T-6-04 | 6 | Интеграционные адаптеры к системам аэропортов | реестр слотов и сообщения (подключаться не к чему) | `test_slot_message_format` | M14 | требует решения (G-54) |
| T-6-05 | 6 | Руководство администратора | `docs/admin-guide.md` | развёртывание администратором заказчика по инструкции | M17 | план |
| T-6-06 | 6 | Руководство пользователя, в том числе для портала | `docs/user-guide*.md` | приёмка заказчиком | M17 | план |
| T-6-07 | 6 | Регламент эксплуатации | `docs/operations.md` | приёмка заказчиком | M17 | план |
| T-7-01 | 7 | Техническая поддержка 6 месяцев после ввода | не запланирована в `TASKS.md` | — | — | требует решения (G-10) |

---

## Сводка на 2026-10-28 (сверка с кодом и тестами)

Строки `план` и `в работе` вех M3–M10 сверены с кодом: для каждой найдены реализация
и тест, имена несуществующих тестов заменены настоящими, статус `реализовано`
поставлен только при зелёном прогоне указанного теста. Где реализация неполна или
испытания нет, строка осталась `в работе` с пометкой «Не сделано». Исправлены также
строки, расходившиеся с кодом: портал клиента (T-3.5.3-*) реализован до ответа по G-05
и проверен тестами; очередь заявок поставщиков — у администратора, а не у руководителя
(T-4.3-15); письмо подтверждения почты уходит адаптером `SMTP`, а не заглушкой (T-4.3-16).
Строки вех M12–M17 и строки без кода не менялись.

| Статус | До сверки | После |
|---|---|---|
| `реализовано` (с уточнением в скобках или без) | 56 | 120 |
| `реализовано (без подключения)` | 0 | 1 |
| `в работе` | 5 | 24 |
| `план` (с уточнением в скобках или без) | 105 | 25 |
| `требует решения` | 14 | 10 |
| `требует согласования` | 1 | 1 |
| `вне объёма` | 1 | 1 |
| **Всего** | **182** | **182** |

Протоколы прогонов — `artifacts/traceability/`: `2026-10-28-pytest.txt` (1047 тестов
сервера), `2026-10-28-vitest.txt` (44 теста клиента), `2026-10-28-e2e-scenario.txt`
(сквозной сценарий, 11 из 11), `2026-10-28-stand-init.txt` (миграции на пустой базе).

## Сводка на 2026-09-13 (закрытие M0)

| Статус | Строк |
|---|---|
| `план` | 158 |
| `в работе` | 2 |
| `требует решения` | 14 |
| `требует согласования` | 1 |
| `вне объёма` | 1 |
| `реализовано` | 0 |
| **Всего** | **176** |

Подсчёт выполняется командой, а не глазами:
`grep -c '^| T-' docs/TRACEABILITY.md` и разбивка по последней колонке.

Строк без статуса нет. Все `требует решения` имеют запись в `GAPS.md` и вошли в письмо
заказчику от 13.09.2026.
