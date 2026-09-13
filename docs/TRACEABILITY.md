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
| `реализовано (stub)` | функция реализована, внешнее подключение не предоставлено заказчиком; в колонке «Примечание» указано, что требуется для перевода в боевой режим |
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
| T-2.1-05 | 2.1 | Роль «Клиенты (авиакомпании)» | `accounts` роль `client` + фильтр арендатора | `/portal/client/*` | портал клиента | `test_tenant_isolation_client` | M3, M8 | план |
| T-2.1-06 | 2.1 | Роль «Поставщики услуг» | `accounts` роль `vendor` + фильтр арендатора | `/portal/vendor/*` | портал поставщика | `test_tenant_isolation_vendor` | M3, M8 | план |
| T-2.2-01 | 2.2 | Планирование с учётом ограничений: слоты | `flights.services.conflicts`, `Slot` (ADR-026) | `GET /slots` | `/slots`, `/schedule` | `test_ready_requires_slot` | M4 | план |
| T-2.2-02 | 2.2 | Планирование с учётом ограничений: допуски | `AircraftApproval`, `CrewQualification` (ADR-027) | `GET /fleet/{id}/approvals` | `/fleet/:id` | `test_conflict_expired_approval` | M4 | план |
| T-2.2-03 | 2.2 | Планирование с учётом техсостояния ВС | `fleet.Aircraft.status` | `GET /fleet` | `/fleet` | `test_conflict_aog_aircraft` | M4 | план |

---

## Раздел 3.1. Модуль «Суточный план полётов»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.1.1-01 | 3.1.1 | Создание рейса с указанием типа ВС и бортового номера | `flights.services.create_flight` | `POST /flights` | `/flights/new` | `test_create_flight` | M4 | план |
| T-3.1.1-02 | 3.1.1 | Маршрут: аэропорты вылета и прилёта | `Flight.dep_icao`, `arr_icao` | `POST /flights` | `/flights/new` | `test_create_flight_route` | M4 | план |
| T-3.1.1-03 | 3.1.1 | Дата и время по UTC и местному | хранение UTC, отображение по `timezoneMode` | `GET /flights/{id}` | карточка рейса | `test_local_time_rendering` | M4, M10 | план |
| T-3.1.1-04 | 3.1.1 | Регулярные рейсы: шаблоны повторяющихся маршрутов | `flights.FlightTemplate` | `GET/POST /flight-templates` | `/schedule/templates` | `test_template_crud` | M4 | план |
| T-3.1.1-05 | 3.1.1 | Генерация серии рейсов из шаблона | `flights.services.generate_series` | `POST /flight-templates/{id}/generate` | `/schedule/templates` | `test_series_dst_boundary` | M4 | план |
| T-3.1.1-06 | 3.1.1 | Gantt-диаграмма, интерактивный планшет загрузки парка | `web/modules/schedule`, vis-timeline | `GET /flights` | `/schedule` | Playwright `schedule-gantt` | M10 | план |
| T-3.1.1-07 | 3.1.1 | Перетаскивание рейса: время, продолжительность, смена борта | `web/modules/schedule` | `PATCH /flights/{id}` | `/schedule` | Playwright `gantt-drag` | M10 | план |
| T-3.1.1-08 | 3.1.1 | Табличный вид с фильтрацией по дате, борту, статусу, типу рейса | `django-filter` + таблица | `GET /flights` | `/schedule` | `test_flight_filters` | M4, M10 | план |
| T-3.1.1-09 | 3.1.1 | Подсветка конфликтов расписания | `flights.services.conflicts` | `GET /flights/conflicts` | `/schedule` | `test_conflict_overlap`, `test_conflict_turnaround` | M4 | план |
| T-3.1.2-01 | 3.1.2 | Статус «Запланирован» | автомат, состояние `planned` | `POST /flights/{id}/status` | карточка рейса | `test_fsm_flight_planned` | M4 | план |
| T-3.1.2-02 | 3.1.2 | Статус «В работе» | состояние `in_work`, guard `start` | `POST /flights/{id}/status` | карточка рейса | `test_fsm_start_guard` | M4 | план |
| T-3.1.2-03 | 3.1.2 | Статус «Готов к вылету»: все услуги подтверждены, разрешения получены | состояние `ready_for_departure`, guard `ready` | `POST /flights/{id}/status` | карточка рейса | `test_ready_blocked_unconfirmed_service` | M4, M5 | план |
| T-3.1.2-04 | 3.1.2 | Статус «В полёте», автоматический переход по факту вылета | `flights.tasks.auto_depart`, адаптер `TRACK` | Celery Beat | `/schedule` | `test_auto_depart` | M4, M13 | план |
| T-3.1.2-05 | 3.1.2 | Статус «Завершён»: услуги выполнены, финдокументы закрыты | состояния `arrived` → `completed` (ADR-009) | `POST /flights/{id}/status` | карточка рейса | `test_complete_requires_invoice` | M4, M7 | план |
| T-3.1.2-06 | 3.1.2 | Статус «Отменён» с оповещением заинтересованных сторон | guard `cancel`, каскадная отмена заявок, письма | `POST /flights/{id}/status` | карточка рейса | `test_cancel_cascade_and_outbox` | M4, M8 | план |
| T-3.1.2-07 | 3.1.2 | Статус «AOG (задержка)» с автоматическим оповещением | состояние `aog`, связь с `Aircraft.status` (ADR-009) | `POST /flights/{id}/status` | карточка рейса, `/fleet` | `test_aog_marks_aircraft_and_notifies` | M4 | план |
| T-3.1.2-08 | 3.1.2 | Запрет присвоения статуса в обход автомата | `django-fsm-2`, `protected=True` | — | — | `test_direct_status_assignment_forbidden` | M4 | план |
| T-3.1.3-01 | 3.1.3 | Изменение рейса: время, борт, маршрут | `flights.services.update_flight` | `PATCH /flights/{id}` | карточка рейса | `test_update_flight` | M4 | план |
| T-3.1.3-02 | 3.1.3 | Автоматическая рассылка уведомлений клиентам при изменении | `comms`, шаблон `flight_schedule_changed` | `GET /outbox` | `/communications/outbox` | `test_schedule_change_notifies_client` | M8 | план |
| T-3.1.3-03 | 3.1.3 | Автоматическая рассылка уведомлений поставщикам при изменении | `comms`, шаблон `order_changed` | `GET /outbox` | `/communications/outbox` | `test_schedule_change_notifies_vendors` | M8 | план |
| T-3.1.3-04 | 3.1.3 | История изменений по рейсу (аудит-лог) | `audit.AuditEntry`, diff в JSONB | `GET /flights/{id}/history` | вкладка «История» | `test_audit_diff_on_update` | M3, M4 | план |
| T-3.1.4-01 | 3.1.4 | Панель рейса: данные о клиенте | карточка рейса, вкладка «Обзор» | `GET /flights/{id}` | `/flights/:id/overview` | Playwright `flight-card` | M10 | план |
| T-3.1.4-02 | 3.1.4 | Панель рейса: список заказанных услуг со статусами | вкладка «Услуги» | `GET /flights/{id}/services` | `/flights/:id/services` | Playwright `flight-card` | M10 | план |
| T-3.1.4-03 | 3.1.4 | Панель рейса: информация о поставщиках по каждой услуге | вкладка «Услуги» | `GET /flights/{id}/services` | `/flights/:id/services` | Playwright `flight-card` | M10 | план |
| T-3.1.4-04 | 3.1.4 | Панель рейса: финансовая сводка (доход, расход, маржа) | вкладка «Финансы» | `GET /flights/{id}/margin` | `/flights/:id/finance` | `test_margin_modes` | M7, M10 | план |

---

## Раздел 3.2. Модуль «Управление услугами»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.2.1-01 | 3.2.1 | Единый справочник услуг с группировкой по категориям | `catalog.Service`, `ServiceCategory` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_service_categories_are_exactly_those_in_the_specification` | M3 | реализовано |
| T-3.2.1-02 | 3.2.1 | Топливообеспечение: Jet A-1, Avgas, цены по аэропортам | позиции каталога + `VendorPrice` по ICAO | `GET /catalog/prices` | `/catalog/prices` | `test_fuel_prices_by_airport` | M3, M5 | план |
| T-3.2.1-03 | 3.2.1 | Наземное обслуживание: техобслуживание, уборка, трапы, буксировка | позиции категории `handling` в `shared/reference/services.json` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_loads_all_datasets` | M3 | реализовано |
| T-3.2.1-04 | 3.2.1 | Кейтеринг — бортовое питание | позиции категории `catering` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_loads_all_datasets` | M3 | реализовано |
| T-3.2.1-05 | 3.2.1 | Транспорт: автобусы для экипажа и пассажиров, VIP-трансферы | позиции категории `transport` | `GET /catalog/services` | `/catalog/services` | `catalog/tests/test_reference.py::test_loads_all_datasets` | M3 | реализовано |
| T-3.2.1-06 | 3.2.1 | Разрешительные документы: пермиты на пролёт, слоты | категория `permits` + `Slot` (ADR-026) | `GET /slots` | `/slots` | `test_permit_and_slot` | M4 | план |
| T-3.2.1-07 | 3.2.1 | Противообледенительная обработка с привязкой к погодным условиям | категория `deicing`, адаптер `WX`, правило ADR-029 | `GET /catalog/services` | мастер заказа | `test_deicing_weather_rule` | M5, M13 | план |
| T-3.2.1-08 | 3.2.1 | Заказ кейтеринга через специализированные системы | адаптер `VENDOR_API` | `GET /integrations` | `/admin/integrations` | `test_adapter_vendor_api_stub` | M14 | план (stub, G-12) |
| T-3.2.2-01 | 3.2.2 | Выбор услуг из каталога при создании рейса | мастер заказа услуги | `POST /flights/{id}/services` | `/flights/:id/services` | Playwright `order-service` | M5, M10 | план |
| T-3.2.2-02 | 3.2.2 | Автопроверка: доступность услуги в аэропорту | `orders.services.checks.availability` | `POST /flights/{id}/services` | мастер заказа | `test_check_service_unavailable` | M5 | план |
| T-3.2.2-03 | 3.2.2 | Автопроверка: наличие действующего контракта с поставщиком | `orders.services.checks.contract_valid` | `POST /flights/{id}/services` | мастер заказа | `test_check_contract_expired` | M5 | план |
| T-3.2.2-04 | 3.2.2 | Автопроверка: актуальность цен и тарифов | `orders.services.checks.price_valid` | `POST /flights/{id}/services` | мастер заказа | `test_check_price_outdated` | M5 | план |
| T-3.2.2-05 | 3.2.2 | Автоматическое резервирование: отправка заявки поставщику | переход `order`, письмо в исходящие | `POST /service-orders/{id}/status` | `/communications/outbox` | `test_order_creates_outbox` | M5, M8 | план |
| T-3.2.2-06 | 3.2.2 | Подтверждение заявки в системе | портал поставщика, адаптер `MAILBOT` | `POST /service-orders/{id}/status` | портал поставщика | `test_vendor_confirms_order` | M8, M14 | план |
| T-3.2.3-01 | 3.2.3 | Статус услуги «Заказана» | автомат заявки, `ordered` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `test_fsm_order_ordered` | M5 | план |
| T-3.2.3-02 | 3.2.3 | Статус «Подтверждена» | `confirmed` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `test_fsm_order_confirmed` | M5 | план |
| T-3.2.3-03 | 3.2.3 | Статус «В процессе» | `in_progress` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `test_fsm_order_in_progress` | M5 | план |
| T-3.2.3-04 | 3.2.3 | Статус «Выполнена» | `completed`, создание `PayableItem` | `POST /service-orders/{id}/status` | `/flights/:id/services` | `test_finish_creates_payable` | M5, M7 | план |
| T-3.2.3-05 | 3.2.3 | Фиксация фактического времени выполнения для биллинга | `actual_start_at`, `actual_end_at` | `PATCH /service-orders/{id}` | `/flights/:id/services` | `test_actual_time_required_on_finish` | M5 | план |
| T-3.2.3-06 | 3.2.3 | Фактическое количество услуги для биллинга | `actual_quantity` (ADR-020) | `PATCH /service-orders/{id}` | `/flights/:id/services` | `test_invoice_uses_actual_quantity` | M5, M7 | план |
| T-3.2.3-07 | 3.2.3 | Загрузка подтверждающих документов (акты, квитанции) | S3 через presigned URL (ADR-007) | `POST /service-orders/{id}/documents` | `/flights/:id/services` | `test_upload_act`, `test_finish_requires_act` | M5 | план |

---

## Раздел 3.3. Модуль «Управление контрагентами»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.3.1-01 | 3.3.1 | Контактные данные поставщика: адрес, телефон, e-mail, контактное лицо | `counterparties.Vendor`, `Contact` | `GET /vendors/{id}` | `/vendors/:id` | `test_vendor_profile` | M6 | план |
| T-3.3.1-02 | 3.3.1 | Специализация: топливо, кейтеринг, хэндлинг, транспорт | `Vendor.specializations` | `GET /vendors` | `/vendors` | `test_vendor_filter_by_specialization` | M6 | план |
| T-3.3.1-03 | 3.3.1 | География покрытия: аэропорты, регионы | `Vendor.coverage` | `GET /vendors` | `/vendors` | `test_vendor_coverage` | M6 | план |
| T-3.3.1-04 | 3.3.1 | Условия сотрудничества: цены, отсрочка, валюты расчётов | `VendorPrice`, `PaymentTerms` (ADR-025) | `GET /catalog/prices` | `/vendors/:id` | `test_vendor_terms_priority` | M6 | план |
| T-3.3.1-05 | 3.3.1 | Рейтинг и отзывы (внутренняя оценка качества) | вычисляемый рейтинг `DOMAIN § 7.4` | `GET /vendors/{id}/rating` | `/vendors/:id` | `test_rating_insufficient_data`, `test_rating_formula` | M6 | план |
| T-3.3.1-06 | 3.3.1 | Сертификаты и допуски (IATA, ADR и др.) с датами | `VendorCertificate` | `GET /vendors/{id}` | `/vendors/:id` | `test_certificate_expiry` | M6 | план |
| T-3.3.2-01 | 3.3.2 | Ручной выбор поставщика диспетчером | `orders.services.assign_vendor` | `PATCH /service-orders/{id}` | мастер заказа | `test_assign_vendor_manual` | M5 | план |
| T-3.3.2-02 | 3.3.2 | Автовыбор по цене | `vendor_suggest`, пресет весов 1/0/0 | `POST /vendors/suggest` | сравнение кандидатов | `test_suggest_by_price` | M6 | план |
| T-3.3.2-03 | 3.3.2 | Автовыбор по рейтингу | пресет 0/1/0 | `POST /vendors/suggest` | сравнение кандидатов | `test_suggest_by_rating` | M6 | план |
| T-3.3.2-04 | 3.3.2 | Автовыбор по географической близости | пресет 0/0/1, гаверсинус | `POST /vendors/suggest` | сравнение кандидатов | `test_suggest_by_proximity` | M6 | план |
| T-3.3.2-05 | 3.3.2 | Автоматическая фиксация закупочной цены при назначении | снимок цены (`CLAUDE.md § 3` п. 5) | `PATCH /service-orders/{id}` | — | `test_price_snapshot_immutable` | M5 | план |
| T-3.3.3-01 | 3.3.3 | Ведение сроков действия договоров с поставщиками | `counterparties.VendorContract` | `GET /contracts` | `/contracts` | `test_contract_status_from_dates` | M6 | план |
| T-3.3.3-02 | 3.3.3 | Автоуведомление об истечении за 30, 15, 7 дней | `contracts.check_expiry` + `dedupe_key` | `GET /notifications` | `/contracts` | `test_expiry_notifications_no_duplicates` | M6 | план |

---

## Раздел 3.4. Модуль «Финансовые условия и взаиморасчёты»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.4.1-01 | 3.4.1 | Предоплата / постоплата / отсрочка платежа для клиента | `Client.payment_terms` | `GET /clients/{id}` | `/clients/:id` | `test_payment_terms_modes` | M6 | план |
| T-3.4.1-02 | 3.4.1 | Валюты расчётов USD, EUR, RUB | `CurrencyCode`, `FxSnapshot` (ADR-004) | `GET /fx-rates` | `/billing/fx` | `test_fx_conversion_via_base` | M7 | план |
| T-3.4.1-03 | 3.4.1 | Скидки и наценки в процентах или фиксированной сумме | `TariffRule.pricing`, `discount` | `GET /clients/{id}/tariffs` | `/clients/:id` | `test_discount_after_markup` | M7 | план |
| T-3.4.1-04 | 3.4.1 | Автоматический расчёт: сумма услуг по ценам клиента | `billing.services.pricing` | `GET /flights/{id}/margin` | `/flights/:id/finance` | `test_tariff_priority_resolution` | M7 | план |
| T-3.4.1-05 | 3.4.1 | Автоматический расчёт: транспортные сборы и комиссии | `DocumentFee` | `POST /quotes` | котировка | `test_fees_in_totals` | M7 | план |
| T-3.4.1-06 | 3.4.1 | Итоговая стоимость в выбранной валюте | `DocumentTotals`, снимок курса | `GET /quotes/{id}` | котировка | `test_totals_currency` | M7 | план |
| T-3.4.1-07 | 3.4.1 | Формирование коммерческого предложения (Quote) до вылета | `billing.Quote` | `POST /quotes`, `/quotes/{id}/issue` | `/billing/quotes` | `test_quote_issue_immutable` | M7 | план |
| T-3.4.1-08 | 3.4.1 | Выгрузка котировки в PDF и Excel | WeasyPrint, openpyxl | `POST /quotes/{id}/export` | `/billing/quotes` | `test_pdf_xlsx_amounts_match` | M7 | план |
| T-3.4.1-09 | 3.4.1 | Автоматическое создание счёта после рейса по фактически оказанным услугам | `billing.Invoice`, `actual_quantity` | `POST /invoices` | `/billing/invoices` | `test_invoice_from_actuals` | M7 | план |
| T-3.4.1-10 | 3.4.1 | Сквозная нумерация документов без дыр | `DocumentCounter` + `select_for_update` | — | — | `test_numbering_100_in_10_threads` | M7 | план |
| T-3.4.1-11 | 3.4.1 | Учёт поступивших платежей и статус оплаты счёта | `billing.Payment` (ADR-019) | `GET/POST /payments` | `/billing/invoices` | `test_invoice_status_from_payments` | M7 | план |
| T-3.4.2-01 | 3.4.2 | Фиксация закупочной цены каждой услуги | снимок в `ServiceOrder` | — | `/flights/:id/services` | `test_price_snapshot_immutable` | M5 | план |
| T-3.4.2-02 | 3.4.2 | Автоформирование заявок на оплату по факту выполнения | `PayableItem` при переходе `finish` | `GET /payables` | `/billing/payables` | `test_finish_creates_payable` | M7 | план |
| T-3.4.2-03 | 3.4.2 | Контроль сроков оплаты с учётом отсрочки | `due_date` из снимка условий контракта | `GET /payables` | `/billing/payables` | `test_payable_due_date_from_contract` | M7 | план |
| T-3.4.2-04 | 3.4.2 | Сверка счетов поставщиков с заказанными услугами | `billing.services.reconciliation` | `POST /reconciliation/import` | `/billing/reconciliation` | `test_reconciliation_four_kinds` | M7 | план |
| T-3.4.2-05 | 3.4.2 | Автоматическое выявление расхождений | алгоритм `DOMAIN § 7.7`, допуск 0.01 | `GET /reconciliation/{id}` | `/billing/reconciliation` | `test_reconciliation_tolerance` | M7 | план |
| T-3.4.2-06 | 3.4.2 | Сопоставление номенклатуры поставщика с каталогом | `VendorServiceMapping` (ADR-024) | `GET /vendor-service-mappings` | `/billing/reconciliation` | `test_vendor_code_mapping` | M7 | план |
| T-3.4.3-01 | 3.4.3 | Маржинальность рейса в реальном времени | `billing.services.margin`, кэш Redis | `GET /flights/{id}/margin` | `/flights/:id/finance` | `test_margin_modes`, `test_margin_sql_matches_python` | M7 | план |
| T-3.4.3-02 | 3.4.3 | Доход от клиента (сумма счёта) | режим `fact` | `GET /flights/{id}/margin` | `/flights/:id/finance` | `test_margin_fact` | M7 | план |
| T-3.4.3-03 | 3.4.3 | Расход на поставщиков (сумма заявок на оплату) | режим `fact` | `GET /flights/{id}/margin` | `/flights/:id/finance` | `test_margin_cost` | M7 | план |
| T-3.4.3-04 | 3.4.3 | Маржа в валюте и процентах | `margin`, `marginPct` (null при нулевой выручке) | `GET /flights/{id}/margin` | `/flights/:id/finance` | `test_margin_zero_revenue` | M7 | план |
| T-3.4.3-05 | 3.4.3 | Оперативная замена поставщика при низкой марже | порог + сравнение кандидатов с пересчётом маржи | `POST /vendors/suggest` | `/flights/:id/finance` | `test_low_margin_suggestion` | M7, M10 | план |

---

## Раздел 3.5. Модуль «Коммуникации и уведомления»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.5.1-01 | 3.5.1 | Оповещение диспетчеров об изменении статуса рейса | `comms.Notification` kind `flight_status` | `GET /notifications` | колокольчик | `test_notify_flight_status` | M8 | план |
| T-3.5.1-02 | 3.5.1 | Оповещение о подтверждении или отказе услуги поставщиком | kind `service_confirmed`, `service_rejected` | `GET /notifications` | колокольчик | `test_notify_service_response` | M8 | план |
| T-3.5.1-03 | 3.5.1 | Оповещение о приближении дедлайнов | kind `deadline`, Celery Beat | `GET /notifications` | колокольчик | `test_notify_deadline` | M8 | план |
| T-3.5.1-04 | 3.5.1 | Интеграция с корпоративным мессенджером MAX | адаптер `MSGR` | `GET /integrations` | `/admin/integrations` | `test_adapter_msgr_stub` | M14 | требует решения (G-04) |
| T-3.5.1-05 | 3.5.1 | Интеграция с e-mail как альтернатива мессенджеру | адаптер `SMTP` | `GET /outbox` | `/communications/outbox` | `test_adapter_smtp_live_cassette` | M13 | план |
| T-3.5.2-01 | 3.5.2 | Рассылка клиентам: подтверждение рейса | шаблон `flight_confirmed` | `GET /outbox` | `/communications/templates` | `test_template_flight_confirmed` | M8 | план |
| T-3.5.2-02 | 3.5.2 | Рассылка клиентам: изменения в расписании | шаблон `flight_schedule_changed` | `GET /outbox` | `/communications/templates` | `test_template_schedule_changed` | M8 | план |
| T-3.5.2-03 | 3.5.2 | Рассылка клиентам: счёт и закрывающие документы | шаблоны `invoice`, `closing_documents` | `GET /outbox` | `/communications/templates` | `test_template_invoice` | M8 | план |
| T-3.5.2-04 | 3.5.2 | Рассылка поставщикам: заявки на услуги | шаблон `vendor_order` | `GET /outbox` | `/communications/templates` | `test_template_vendor_order` | M8 | план |
| T-3.5.2-05 | 3.5.2 | Рассылка поставщикам: напоминания о сроках исполнения | шаблон `vendor_reminder`, Celery Beat | `GET /outbox` | `/communications/templates` | `test_template_vendor_reminder` | M8 | план |
| T-3.5.2-06 | 3.5.2 | Язык письма по локали получателя | версии шаблона ru/en | `GET /outbox` | `/communications/templates` | `test_template_locale_en` | M8 | план |
| T-3.5.3-01 | 3.5.3 | Портал клиента: заказ рейсов самостоятельно | заявка на рейс → очередь диспетчера | `POST /portal/client/flight-requests` | портал клиента | `test_client_request_becomes_flight` | M8 | требует решения (G-05) |
| T-3.5.3-02 | 3.5.3 | Портал клиента: заказ рейсов по шаблонам | шаблоны клиента | `POST /portal/client/flight-requests` | портал клиента | `test_client_request_from_template` | M8 | требует решения (G-05) |
| T-3.5.3-03 | 3.5.3 | Портал клиента: отслеживание статусов рейсов и услуг | фильтр арендатора | `GET /portal/client/flights` | портал клиента | `test_client_sees_only_own_flights` | M8 | требует решения (G-05) |
| T-3.5.3-04 | 3.5.3 | Портал клиента: история заказов и финансовые документы | — | `GET /portal/client/documents` | портал клиента | `test_client_documents_no_purchase_prices` | M8 | требует решения (G-05) |
| T-3.5.3-05 | 3.5.3 | Портал клиента: принятие или отклонение котировки | ADR-030 | `POST /quotes/{id}/accept` | портал клиента | `test_client_accepts_quote` | M8 | требует решения (G-05) |

---

## Раздел 3.6. Модуль «Отчётность и аналитика»

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-3.6.1-01 | 3.6.1 | Суточный, недельный, месячный отчёт по рейсам | отчёт `flights_period` | `GET /reports/flights_period` | `/reports/:code` | `test_report_flights_period` | M9 | план |
| T-3.6.1-02 | 3.6.1 | Отчёт по оказанным услугам с группировкой по типу | отчёт `services_rendered` | `GET /reports/services_rendered` | `/reports/:code` | `test_report_services` | M9 | план |
| T-3.6.1-03 | 3.6.1 | Финансовый отчёт: доходы, расходы, маржинальность | отчёт `financial` | `GET /reports/financial` | `/reports/:code` | `test_report_financial_matches_flights` | M9 | план |
| T-3.6.1-04 | 3.6.1 | Отчёт по поставщикам: объём заказов, качество, задержки | отчёт `vendors` | `GET /reports/vendors` | `/reports/:code` | `test_report_vendors_matches_rating` | M9 | план |
| T-3.6.1-05 | 3.6.1 | Отчёт по дебиторской и кредиторской задолженности | отчёт `receivables_payables` | `GET /reports/receivables_payables` | `/reports/:code` | `test_report_aging_buckets` | M9 | план |
| T-3.6.1-06 | 3.6.1 | Реестр нарушений SLA | отчёт `sla_breaches` | `GET /reports/sla_breaches` | `/reports/:code` | `test_report_sla` | M9 | план |
| T-3.6.1-07 | 3.6.1 | Журнал изменений рейсов за период | отчёт `flight_audit` | `GET /reports/flight_audit` | `/reports/:code` | `test_report_audit_export` | M9 | план |
| T-3.6.2-01 | 3.6.2 | Дашборд диспетчера: текущий статус рейсов, критические задержки | `reports.dashboards.dispatcher` | `GET /dashboards/dispatcher` | `/dashboards/dispatcher` | `test_dashboard_dispatcher` | M9 | план |
| T-3.6.2-02 | 3.6.2 | Дашборд руководителя: количество рейсов, загрузка, маржинальность по клиентам | `reports.dashboards.manager` | `GET /dashboards/manager` | `/dashboards/manager` | `test_dashboard_manager` | M9 | план |
| T-3.6.2-03 | 3.6.2 | Настройка виджетов под роль пользователя | раскладка на пользователя | `PUT /dashboards/{role}/layout` | дашборды | `test_dashboard_layout_persist` | M9, M10 | план |
| T-3.6.3-01 | 3.6.3 | Выгрузка отчётов в PDF | WeasyPrint | `POST /reports/{code}/export` | `/reports/:code` | `test_export_pdf` | M9 | план |
| T-3.6.3-02 | 3.6.3 | Выгрузка отчётов в Excel (XLSX) | openpyxl | `POST /reports/{code}/export` | `/reports/:code` | `test_export_xlsx` | M9 | план |
| T-3.6.3-03 | 3.6.3 | Выгрузка отчётов в CSV | стандартный `csv` | `POST /reports/{code}/export` | `/reports/:code` | `test_export_csv` | M9 | план |
| T-3.6.3-04 | 3.6.3 | Выгрузка отчётов в XML | схема `soc-report-v1.xsd` (ADR-032) | `POST /reports/{code}/export` | `/reports/:code` | `test_export_xml_validates_xsd` | M9 | план |
| T-3.6.3-05 | 3.6.3 | Отправка отчётов по e-mail по расписанию | подписки + `reports.scheduled` | `GET/POST /report-subscriptions` | `/reports` | `test_scheduled_report_to_outbox` | M9 | план |

---

## Раздел 4. Технические требования

| ID | Пункт | Требование | Реализация | Эндпоинт | Экран | Тест | Веха | Статус |
|---|---|---|---|---|---|---|---|---|
| T-4.1-01 | 4.1 | Веб-приложение как основной интерфейс | React 18 + Vite + Ant Design | — | все | Playwright | M10 | план |
| T-4.1-02 | 4.1 | Мобильное приложение Android | Expo, EAS Build (ADR-006) | — | мобильные экраны | Maestro + установка на устройство | M12 | план |
| T-4.1-03 | 4.1 | Мобильное приложение iOS | Expo, TestFlight (ADR-006) | — | мобильные экраны | Maestro + TestFlight | M12 | план |
| T-4.1-04 | 4.1 | Профиль «полевой персонал» | профиль диспетчера с урезанными правами | `/auth/me` | мобильные экраны | `test_permissions_field_staff` | M12 | требует решения (G-50) |
| T-4.1-05 | 4.1 | SaaS-архитектура | `Organization` + `TenantScopedMixin` (ADR-003) | все | — | `tests/test_tenant_isolation.py` | M3 | реализовано |
| T-4.1-06 | 4.1 | Развёртывание on-premise | тот же набор образов, другая конфигурация | — | — | развёртывание на чистой машине | M1, M17 | план |
| T-4.1-07 | 4.1 | Клиент-серверная архитектура (Windows-сервис) | контейнеры Linux, в том числе на сервере Windows | — | — | — | — | требует решения (G-02) |
| T-4.1-08 | 4.1 | БД PostgreSQL | PostgreSQL 16 (ADR-001) | — | — | `make migrate` на чистой базе | M1 | план |
| T-4.1-09 | 4.1 | БД MSSQL | не реализуется (ADR-001) | — | — | — | — | требует решения (G-01) |
| T-4.1-10 | 4.1 | Кластеризация для отказоустойчивости | реплика с ручным переключением (ADR-001, `INFRA § 7`) | — | — | испытание переключения | M15 | план |
| T-4.2-01 | 4.2 | REST API для интеграции с внешними системами | DRF + `openapi.yaml`, `/api/v1` | все | `/api-docs` | `schemathesis` | M1–M15 | в работе |
| T-4.2-02 | 4.2 | Интеграция с 1С: счета, платежи, списания | адаптер `ONEC` (OData) | `POST /integrations/ONEC/test` | `/admin/integrations` | `test_adapter_onec_cassette` | M14 | план (stub до доступа) |
| T-4.2-03 | 4.2 | Системы аэропортов: слоты | реестр слотов + сообщения SCR (ADR-026) | `GET /slots` | `/slots` | `test_slot_message_format` | M14 | план (публичного API нет) |
| T-4.2-04 | 4.2 | Системы аэропортов: статус обслуживания | ведётся вручную в реестре поставщиков | — | `/vendors/:id` | — | M6 | вне объёма (нет источника) |
| T-4.2-05 | 4.2 | Системы поставщиков: обмен заявками и подтверждениями | портал поставщика + `MAILBOT` + `VENDOR_API` | `/portal/vendor/*` | портал поставщика | `test_adapter_mailbot_stub` | M8, M14 | план |
| T-4.2-06 | 4.2 | IATA BDG для стандартизации биллинговых данных | выгрузка IS-XML (ADR-032) | `POST /reports/{code}/export` | `/reports` | `test_export_isxml` | M14 | требует решения (G-03) |
| T-4.2-07 | 4.2 | Импорт/экспорт через ODBC-драйверы | реплика только для чтения + представления (ADR-005) | — | — | подключение DBeaver по ODBC | M13 | требует согласования (G-49) |
| T-4.2-08 | 4.2 | Интеграция с Power BI | те же представления | — | — | построение отчёта в Power BI | M13 | план |
| T-4.2-09 | 4.2 | Интеграция с Tableau | те же представления | — | — | подключение Tableau | M13 | план |
| T-4.3-01 | 4.3 | Аутентификация LDAP / Active Directory | адаптер `LDAP`, `django-auth-ldap` | `POST /auth/login` | `/login` | `test_adapter_ldap_stub`, `test_ldap_group_to_role` | M3, M14 | план (stub до доступа) |
| T-4.3-02 | 4.3 | Двухфакторная аутентификация | TOTP `pyotp`, резервные коды (ADR-013) | `POST /auth/2fa` | `/login` | `accounts/tests/test_auth.py::TestTwoFactor`, `e2e/helpers/session.ts` | M3 | реализовано |
| T-4.3-03 | 4.3 | Ролевая модель доступа: 6 ролей ТЗ | карта `role → permission`, единая с клиентом | `GET /auth/me` | `/admin/users` | `tests/test_permissions.py`, `tests/test_permission_map.py` | M3 | реализовано |
| T-4.3-04 | 4.3 | Проверка прав на сервере в каждом эндпоинте | `HasRolePermission`: действие без объявленного права запрещено | все | — | `tests/test_permissions.py::TestEndpointPermissions` | M3 | реализовано |
| T-4.3-05 | 4.3 | Изоляция данных порталов | `TenantScopedViewSet`, 404 вместо 403 | портальные | порталы | `test_tenant_leak_<endpoint>` | M3, M8 | план |
| T-4.3-06 | 4.3 | Логирование изменения статуса рейса | `audit` | `GET /audit` | `/admin/audit` | `test_audit_flight_status` | M3, M4 | план |
| T-4.3-07 | 4.3 | Логирование замены поставщика | `audit` | `GET /audit` | `/admin/audit` | `test_audit_vendor_assigned` | M3, M5 | план |
| T-4.3-08 | 4.3 | Логирование выставления счёта | `audit` | `GET /audit` | `/admin/audit` | `test_audit_invoice_issued` | M3, M7 | план |
| T-4.3-09 | 4.3 | Неизменяемость записей аудита | триггер `audit_entry_append_only` (ADR-033) | `GET /audit` | `/admin/audit` | `audit/tests/test_audit.py::TestImmutability` | M3 | реализовано |
| T-4.3-10 | 4.3 | Защита персональных данных экипажа (152-ФЗ) | ограничение доступа, журналирование, обезличивание (ADR-028) | `GET /crew` | карточка рейса | `test_crew_access_logged` | M3, M4 | план |
| T-4.4-01 | 4.4 | Одновременная работа до 50 пользователей без деградации | — | — | — | k6, профиль 50 VU, 15 мин | M15 | план |
| T-4.4-02 | 4.4 | Открытие карточки рейса не более 2 секунд | — | `GET /flights/{id}` | `/flights/:id` | k6 `p95 < 2000` + LCP (ADR-017) | M15 | план |
| T-4.4-03 | 4.4 | Расчёт маржинальности не более 5 секунд | кэш Redis, чистая функция | `GET /flights/{id}/margin` | `/flights/:id/finance` | k6 `p95 < 5000` | M15 | план |
| T-4.4-04 | 4.4 | Восстановление после сбоя не более 30 минут | pgBackRest, инструкция администратора | — | — | учебное восстановление с хронометражом | M15 | план |
| T-4.4-05 | 4.4 | Резервное копирование ежедневно | pgBackRest: полная еженедельно, инкрементальная ежедневно, WAL непрерывно | — | — | журнал заданий | M15, M16 | план |
| T-4.4-06 | 4.4 | Хранение резервных копий 30 дней | политика хранения pgBackRest | — | — | проверка политики | M15 | план |
| T-4.5-01 | 4.5 | Интерфейс на русском языке | `i18next`, `ru` | — | все | `test_no_hardcoded_strings` | M1, M10 | план |
| T-4.5-02 | 4.5 | Интерфейс на английском языке | `i18next`, `en` | — | все | `test_locale_completeness` | M1, M10 | план |
| T-4.5-03 | 4.5 | Наименования справочников на двух языках | `name_ru` / `name_en` (ADR-031) | справочные | справочники | `catalog/tests/test_reference.py::test_verified_airports_have_russian_names` | M3 | реализовано |
| T-4.5-04 | 4.5 | Отображение данных в разных часовых поясах (UTC / локальное) | `timezoneMode`, обязательная подпись зоны | — | все | `test_timezone_modes` | M10 | план |

---

## Разделы 5–7. Этапы, поставка, поддержка

| ID | Пункт | Требование | Реализация | Тест / подтверждение | Веха | Статус |
|---|---|---|---|---|---|---|
| T-5-01 | 5, этап 1 | Утверждённый протокол требований | `GAPS.md`, `DECISIONS.md`, `openapi.yaml`, письмо заказчику | подпись заказчика | M0 | в работе |
| T-5-02 | 5, этап 2 | Кликабельные макеты для утверждения | веб-клиент на статических данных | утверждение заказчиком, скриншоты в `artifacts/screenshots/m2/` | M2 | план |
| T-5-03 | 5, этап 3 | Рабочее ядро системы | M3–M10 | `make check` зелёный, сквозной сценарий | M3–M10 | план |
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
