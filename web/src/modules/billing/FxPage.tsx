import type { JSX } from 'react';
import { Alert, Card, Col, Descriptions, Row, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';

import { FX_HISTORY, FX_TODAY } from '@/mocks/billing';
import { DateText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

interface Rate {
  date: string;
  usd: string;
  eur: string;
}

/** Простой спарклайн без внешней библиотеки: на M10 заменяется ECharts. */
function Sparkline({ values, color }: { values: number[]; color: string }): JSX.Element {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 280;
      const y = 48 - ((value - min) / span) * 44;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={280} height={52} role="img" aria-hidden>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

/**
 * Курсы валют и политика фиксации `[ТЗ 3.4.1]`.
 *
 * ADR-004: база — рубль, `rates[c]` — сколько рублей стоит одна единица
 * валюты `c`, номинал источника нормализован при загрузке. Политика
 * `payment_date` исключена как нереализуемая: документ выставляется до оплаты.
 *
 * При недоступности источника система работает на последнем известном курсе
 * и выводит предупреждение — предсказуемая деградация вместо падения.
 */
export function FxPage(): JSX.Element {
  const { t } = useTranslation();

  const columns: ColumnsType<Rate> = [
    {
      title: t('fx.date'), dataIndex: 'date', width: 140,
      render: (value: string) => <DateText value={value} />,
    },
    {
      title: 'USD → RUB', dataIndex: 'usd', align: 'right',
      render: (value: string) => <Mono>{Number.parseFloat(value).toFixed(4)}</Mono>,
    },
    {
      title: 'EUR → RUB', dataIndex: 'eur', align: 'right',
      render: (value: string) => <Mono>{Number.parseFloat(value).toFixed(4)}</Mono>,
    },
  ];

  const usdValues = FX_HISTORY.map((r) => Number.parseFloat(r.usd));
  const eurValues = FX_HISTORY.map((r) => Number.parseFloat(r.eur));

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.fx')}</Typography.Title>

      <Alert
        type="info"
        showIcon
        message={t('fx.sourceNotice')}
        description={t('fx.sourceHint')}
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('fx.current')}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('fx.base')}>
                <Mono>{FX_TODAY.base}</Mono>
              </Descriptions.Item>
              <Descriptions.Item label="USD">
                <Mono>1 USD = {FX_TODAY.rates['USD']} RUB</Mono>
              </Descriptions.Item>
              <Descriptions.Item label="EUR">
                <Mono>1 EUR = {FX_TODAY.rates['EUR']} RUB</Mono>
              </Descriptions.Item>
              <Descriptions.Item label={t('fx.policy')}>
                <Space direction="vertical" size={0}>
                  <Tag>{t(`fxPolicy.${FX_TODAY.policy}`)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('fx.policyHint')}
                  </Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('common.dataSource')}>
                <Tag color="purple">{t('demo.synthetic')}</Tag>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card size="small" title={t('fx.dynamics')}>
            <Space direction="vertical" size={12}>
              <Space direction="vertical" size={0}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>USD → RUB</Typography.Text>
                <Sparkline values={usdValues} color={STATUS_TOKENS.progress.color} />
              </Space>
              <Space direction="vertical" size={0}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>EUR → RUB</Typography.Text>
                <Sparkline values={eurValues} color={STATUS_TOKENS.active.color} />
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('fx.chartHint')}
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<Rate>
          size="small" rowKey="date" columns={columns}
          dataSource={[...FX_HISTORY].reverse()}
          pagination={{ pageSize: 10, size: 'small' }}
        />
      </Card>
    </Space>
  );
}
