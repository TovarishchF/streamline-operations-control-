import { useState, type JSX } from 'react';
import { Card, Col, Radio, Row, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { useFlightMargin, type MarginMode } from '@/api/billing';
import type { Flight } from '@/api/flights';
import type { ServiceOrderRow } from '@/api/orders';
import { usePermission } from '@/shared/auth/session';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { QueryState } from '@/shared/ui/QueryState';
import { MoneyText, Mono, PercentText } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { Notice } from '@/shared/ui/Notice';

/**
 * Финансовая сводка рейса `[ТЗ 3.4.3]`.
 *
 * `CLAUDE.md § 3` п. 16: компонент не содержит доменных расчётов. Маржа,
 * выручка и расход приходят с сервера (`GET /flights/{id}/margin`) —
 * здесь они только отображаются.
 *
 * Отрицательная маржа показывается, а не обнуляется; нулевая выручка даёт
 * «—» в проценте, а не ноль (`DOMAIN.md § 7.3`).
 */
export function FlightFinanceTab({
  flight,
  orders,
}: {
  flight: Flight;
  orders: ServiceOrderRow[];
}): JSX.Element {
  const { t } = useTranslation();
  const localized = useLocalizedName();
  const [mode, setMode] = useState<MarginMode>('mixed');
  const canSeePurchase = usePermission('billing.purchase_price.view');
  const marginQuery = useFlightMargin(flight.id, mode);

  // Строки показывают, из чего сложилась сумма: в плане — всё, что
  // не отменено и не отклонено, в факте — выполненное (`DOMAIN.md § 7.3`).
  const included = orders.filter((order) => {
    if (mode === 'fact') return order.status === 'completed';
    return order.status !== 'cancelled' && order.status !== 'rejected';
  });

  const purchaseColumn: DataColumns<ServiceOrderRow> = canSeePurchase
    ? [
        {
          title: t('service.purchaseCost'),
          key: 'cost',
          width: 140,
          align: 'right',
          render: (_, row) => <MoneyText value={row.purchaseCost} />,
        },
      ]
    : [];

  const columns: DataColumns<ServiceOrderRow> = [
    {
      title: t('service.name'),
      key: 'name',
      ellipsis: true,
      render: (_, row) => (row.service ? localized(row.service.name) : row.serviceId),
    },
    {
      title: t('service.leg'),
      dataIndex: 'airportIcao',
      width: 80,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    ...purchaseColumn,
    {
      title: t('service.salePrice'),
      key: 'sale',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.salePrice} />,
    },
    {
      title: t('finance.tariffRule'),
      dataIndex: 'tariffRuleId',
      width: 130,
      render: (value: string | null) =>
        value ? (
          <Tooltip title={t('finance.tariffRuleHint')}>
            <Mono>{value}</Mono>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space size={12} wrap align="center">
        <Radio.Group
          size="small"
          optionType="button"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as MarginMode);
          }}
          options={[
            { label: t('marginMode.plan'), value: 'plan' },
            { label: t('marginMode.fact'), value: 'fact' },
            { label: t('marginMode.mixed'), value: 'mixed' },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t(`marginMode.hint.${mode}`)}
        </Typography.Text>
      </Space>

      <QueryState query={marginQuery} skeletonRows={3}>
        {(margin) => {
          const lowMarginStyle = margin.isBelowThreshold
            ? { borderColor: STATUS_TOKENS.warning.border, background: STATUS_TOKENS.warning.background }
            : undefined;
          const base = margin.fx.base ?? margin.currency;
          return (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {mode === 'mixed' && margin.planPortionPercent ? (
                <Notice
                  id="finance.mixed"
                  type="info"
                  showIcon
                  message={t('finance.mixedNotice', { percent: margin.planPortionPercent })}
                />
              ) : null}

              <Row gutter={[12, 12]}>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title={t('finance.revenue')}
                      value={0}
                      valueRender={() => <MoneyText value={margin.revenue} strong />}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title={t('finance.cost')}
                      value={0}
                      valueRender={() => <MoneyText value={margin.cost} strong />}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small" style={lowMarginStyle}>
                    <Statistic
                      title={t('finance.margin')}
                      value={0}
                      valueRender={() => <MoneyText value={margin.margin} strong colorBySign />}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small" style={lowMarginStyle}>
                    <Statistic
                      title={t('finance.marginPercent')}
                      value={0}
                      valueRender={() => (
                        <PercentText
                          value={margin.marginPercent}
                          colorBySign
                          threshold={Number.parseFloat(margin.thresholdPercent)}
                        />
                      )}
                    />
                  </Card>
                </Col>
              </Row>

              {/* Курс показывается рядом с суммами: он зафиксирован снимком (ADR-004) */}
              <Card size="small" styles={{ body: { padding: 10 } }}>
                <Space size={16} wrap>
                  <Typography.Text type="secondary">{t('finance.fxSnapshot')}:</Typography.Text>
                  {Object.entries(margin.fx.rates)
                    .filter(([code]) => code !== base)
                    .map(([code, rate]) => (
                      <Mono key={code}>
                        1 {code} = {rate} {base}
                      </Mono>
                    ))}
                  {margin.fx.date ? <Mono>{margin.fx.date}</Mono> : null}
                  {margin.fx.policy ? <Tag>{t(`fxPolicy.${margin.fx.policy}`)}</Tag> : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('finance.fxSnapshotHint')}
                  </Typography.Text>
                </Space>
              </Card>
            </Space>
          );
        }}
      </QueryState>

      <DataTable<ServiceOrderRow>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={included}
        pagination={false}
        scroll={{ x: 700 }}
      />
    </Space>
  );
}
