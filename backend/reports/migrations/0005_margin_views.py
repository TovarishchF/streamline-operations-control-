"""Агрегатный путь маржи для дашбордов (ADR-012, `TASKS.md` M9 п. 2).

Два материализованных представления на `NUMERIC` — ни одного `double
precision` (`CLAUDE.md § 3` п. 1):

* `reports_order_margin` — вклад каждой заявки в маржу рейса в режиме
  `mixed`, в валюте рейса по снимку курсов рейса;
* `reports_flight_margin` — итоги рейса: выручка с учётом сборов и скидок
  выставленных счетов, расход, оба округлены до копейки.

Правила те же, что у каноничного расчёта `billing.services.margin`, и
совпадение двух путей проверяет тест: расхождение хотя бы в копейку на
одном рейсе валит сборку. Обновляются задачей `reports.refresh_views`.

Колонки, на которые опираются представления, нельзя изменить миграцией,
не пересоздав представления: база откажет. Это правильно — изменение
формулы обязано пройти через этот файл и через тест сверки.
"""

from __future__ import annotations

from django.db import migrations

BILLED = "('issued', 'sent', 'partially_paid', 'paid', 'overdue')"

ORDER_MARGIN = f"""
CREATE MATERIALIZED VIEW reports_order_margin AS
WITH base AS (
    SELECT
        o.id AS order_id,
        o.flight_id,
        f.client_id,
        f.std_utc,
        f.billing_currency AS currency,
        f.fx_snapshot -> 'rates' AS rates,
        s.category,
        o.vendor_id,
        o.status,
        o.status = 'completed' AS is_fact,
        CASE WHEN o.status = 'completed'
             THEN COALESCE(line.amount, o.actual_sale_amount)
             ELSE o.sale_amount END AS sale_raw,
        CASE WHEN o.status = 'completed'
             THEN CASE WHEN line.amount IS NOT NULL THEN line.currency
                       ELSE f.billing_currency END
             ELSE o.sale_currency END AS sale_currency,
        CASE WHEN o.status = 'completed'
             THEN o.actual_cost_amount
             ELSE o.purchase_cost_amount END AS cost_raw,
        o.purchase_currency AS cost_currency
    FROM orders_serviceorder o
    JOIN flights_flight f ON f.id = o.flight_id
    JOIN catalog_service s ON s.id = o.service_id
    LEFT JOIN LATERAL (
        SELECT l.amount, l.currency
        FROM billing_documentline l
        JOIN billing_invoice i ON i.id = l.invoice_id
        WHERE l.service_order_id = o.id AND i.status IN {BILLED}
        ORDER BY i.issued_at DESC, l.created_at DESC
        LIMIT 1
    ) line ON TRUE
    WHERE o.status NOT IN ('cancelled', 'rejected')
),
converted AS (
    SELECT
        base.*,
        CASE WHEN sale_currency = currency THEN sale_raw
             ELSE ROUND(
                 sale_raw * (rates ->> sale_currency)::numeric
                 / NULLIF((rates ->> currency)::numeric, 0), 4)
        END AS sale,
        CASE WHEN cost_currency = currency THEN cost_raw
             ELSE ROUND(
                 cost_raw * (rates ->> cost_currency)::numeric
                 / NULLIF((rates ->> currency)::numeric, 0), 4)
        END AS cost
    FROM base
    WHERE sale_raw IS NOT NULL AND cost_raw IS NOT NULL
)
SELECT order_id, flight_id, client_id, std_utc, currency, rates, category, vendor_id,
       status, is_fact, sale, cost
FROM converted
WHERE sale IS NOT NULL AND cost IS NOT NULL
WITH DATA;

CREATE UNIQUE INDEX reports_order_margin_pk ON reports_order_margin (order_id);
CREATE INDEX reports_order_margin_flight ON reports_order_margin (flight_id);
CREATE INDEX reports_order_margin_std ON reports_order_margin (std_utc);
"""

FLIGHT_MARGIN = f"""
CREATE MATERIALIZED VIEW reports_flight_margin AS
WITH orders AS (
    SELECT flight_id, SUM(sale) AS sale, SUM(cost) AS cost
    FROM reports_order_margin
    GROUP BY flight_id
),
documents AS (
    SELECT
        i.flight_id,
        SUM(
            CASE WHEN i.currency = f.billing_currency THEN i.fees_amount
                 ELSE ROUND(
                     i.fees_amount * (f.fx_snapshot -> 'rates' ->> i.currency)::numeric
                     / NULLIF((f.fx_snapshot -> 'rates' ->> f.billing_currency)::numeric, 0), 4)
            END
            - CASE WHEN i.currency = f.billing_currency THEN i.discount_amount
                   ELSE ROUND(
                       i.discount_amount * (f.fx_snapshot -> 'rates' ->> i.currency)::numeric
                       / NULLIF((f.fx_snapshot -> 'rates' ->> f.billing_currency)::numeric, 0), 4)
              END
        ) AS adjustment
    FROM billing_invoice i
    JOIN flights_flight f ON f.id = i.flight_id
    WHERE i.status IN {BILLED}
    GROUP BY i.flight_id
)
SELECT
    f.id AS flight_id,
    f.client_id,
    f.aircraft_id,
    f.std_utc,
    f.billing_currency AS currency,
    f.fx_snapshot -> 'rates' AS rates,
    ROUND(COALESCE(o.sale, 0) + COALESCE(d.adjustment, 0), 2) AS revenue,
    ROUND(COALESCE(o.cost, 0), 2) AS cost
FROM flights_flight f
LEFT JOIN orders o ON o.flight_id = f.id
LEFT JOIN documents d ON d.flight_id = f.id
WITH DATA;

CREATE UNIQUE INDEX reports_flight_margin_pk ON reports_flight_margin (flight_id);
CREATE INDEX reports_flight_margin_std ON reports_flight_margin (std_utc);
"""


class Migration(migrations.Migration):

    dependencies = [
        ("reports", "0004_dashboard_layout"),
        ("orders", "0007_sale_and_actual_snapshots"),
        ("billing", "0007_payments"),
        ("flights", "0004_is_generated_drop_previous"),
        ("catalog", "0004_is_generated_drop_previous"),
    ]

    operations = [
        migrations.RunSQL(
            ORDER_MARGIN,
            reverse_sql="DROP MATERIALIZED VIEW IF EXISTS reports_order_margin;",
        ),
        migrations.RunSQL(
            FLIGHT_MARGIN,
            reverse_sql="DROP MATERIALIZED VIEW IF EXISTS reports_flight_margin;",
        ),
    ]
