import { useState, type JSX } from 'react';
import { Alert, Card, Col, Radio, Row, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { Flight } from '@/api/flights';
import type { ServiceOrderRow } from '@/api/orders';
import type { MarginMode } from '@/api/types';
import { MARGINS } from '@/mocks/flights';
import { usePermission } from '@/shared/auth/session';
import { MoneyText, Mono, PercentText } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

/**
 * Финансовая сводка рейса `[ТЗ 3.4.3]`.
 *
 * `CLAUDE.md § 3` п. 16: компонент не содержит доменных расчётов. Маржа,
 * выручка и расход приходят готовыми — здесь они только отображаются.
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
  const [mode, setMode] = useState<MarginMode>('mixed');
  const canSeePurchase = usePermission('billing.purchase_price.view');
  const margin = MARGINS.get(flight.id);

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
      render: (_, row) => row.service?.name.ru ?? row.serviceId,
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

  const lowMarginStyle = margin?.isBelowThreshold
    ? { borderColor: STATUS_TOKENS.warning.border, background: STATUS_TOKENS.warning.background }
    : undefined;

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

      {mode === 'mixed' && margin?.planPortionPercent ? (
        <Alert
          type="info"
          showIcon
          message={t('finance.mixedNotice', {
            percent: Number.parseFloat(margin.planPortionPercent).toFixed(0),
          })}
        />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('finance.revenue')}
              value={0}
              valueRender={() => <MoneyText value={margin?.revenue} strong />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={t('finance.cost')}
              value={0}
              valueRender={() => <MoneyText value={margin?.cost} strong />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={lowMarginStyle}>
            <Statistic
              title={t('finance.margin')}
              value={0}
              valueRender={() => <MoneyText value={margin?.margin} strong colorBySign />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={lowMarginStyle}>
            <Statistic
              title={t('finance.marginPercent')}
              value={0}
              valueRender={() => (
                <PercentText value={margin?.marginPercent ?? null} colorBySign threshold={12} />
              )}
            />
          </Card>
        </Col>
      </Row>

      {/* Курс показывается рядом с суммами: он зафиксирован снимком (ADR-004) */}
      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Space size={16} wrap>
          <Typography.Text type="secondary">{t('finance.fxSnapshot')}:</Typography.Text>
          <Mono>1 USD = {margin?.fx?.rates['USD'] ?? '—'} RUB</Mono>
          <Mono>1 EUR = {margin?.fx?.rates['EUR'] ?? '—'} RUB</Mono>
          <Tag>{t(`fxPolicy.${margin?.fx?.policy ?? 'document_date'}`)}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('finance.fxSnapshotHint')}
          </Typography.Text>
        </Space>
      </Card>

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
