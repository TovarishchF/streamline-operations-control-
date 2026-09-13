import type { JSX } from 'react';
import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Slot } from '@/api/types';
import { FLIGHT_BY_ID, SLOTS } from '@/mocks/flights';
import { AIRPORT_BY_ICAO } from '@/mocks/reference';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  requested: 'progress', confirmed: 'done', rejected: 'critical', cancelled: 'cancelled',
};

/**
 * Реестр слотов `[ТЗ 3.2.1, 4.2]` (ADR-026).
 *
 * **Публичного интерфейса слот-координации не существует.** Координаторы
 * работают сообщениями формата IATA SSIM по электронной почте и через
 * собственные веб-кабинеты. Система ведёт реестр, формирует сообщение SCR
 * по шаблону и разбирает ответ — это инструмент подготовки переписки,
 * а не интеграция, и мы не называем это интеграцией (`INTEGRATIONS.md § 5.1`).
 */
export function SlotsPage(): JSX.Element {
  const { t } = useTranslation();

  const columns: ColumnsType<Slot> = [
    {
      title: t('flight.airport'), dataIndex: 'airportIcao', width: 190,
      render: (value: string) => (
        <Space direction="vertical" size={0}>
          <Mono>{value}</Mono>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {AIRPORT_BY_ICAO.get(value)?.name.ru}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('flight.number'), dataIndex: 'flightId', width: 120,
      render: (value: string) => (
        <Link to={`/flights/${value}`}>
          <Mono>{FLIGHT_BY_ID.get(value)?.number ?? value}</Mono>
        </Link>
      ),
    },
    {
      title: t('slots.kind'), dataIndex: 'kind', width: 120,
      render: (value: string) => <Tag style={{ margin: 0 }}>{t(`slotKind.${value}`)}</Tag>,
    },
    {
      title: t('slots.requested'), dataIndex: 'requestedTimeUtc', width: 120,
      render: (value: string | null) => <UtcTime value={value} withDate />,
    },
    {
      title: t('slots.confirmed'), dataIndex: 'confirmedTimeUtc', width: 120,
      render: (value: string | null) => <UtcTime value={value} withDate />,
    },
    {
      title: t('slots.status'), dataIndex: 'status', width: 150,
      render: (value: string) => {
        const token = STATUS_TOKENS[TOKEN[value] ?? 'neutral'];
        return (
          <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
            {t(`slotStatus.${value}`)}
          </Tag>
        );
      },
    },
    {
      title: t('slots.messageRef'), dataIndex: 'messageRef', width: 200,
      render: (value: string | null) =>
        value ? <Mono>{value}</Mono> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('slots.comment'), dataIndex: 'comment', ellipsis: true,
      render: (value: string | null) => value ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('common.actions'), key: 'actions', width: 190, fixed: 'right',
      render: (_, row) => (
        <Space size={4} wrap>
          <Button size="small">{t('slots.buildScr')}</Button>
          {row.status === 'requested' ? (
            <Button size="small" type="primary">{t('slots.applyAnswer')}</Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.slots')}</Typography.Title>
        <Button type="primary">{t('slots.newRequest')}</Button>
      </Space>

      <Alert
        type="info"
        showIcon
        message={t('slots.noPublicApiNotice')}
        description={t('slots.noPublicApiHint')}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<Slot>
          size="small" rowKey="id" columns={columns} dataSource={SLOTS}
          pagination={false} scroll={{ x: 1250 }}
          locale={{ emptyText: <EmptyState description={t('slots.empty')} /> }}
        />
      </Card>
    </Space>
  );
}
