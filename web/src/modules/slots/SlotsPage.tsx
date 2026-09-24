import { useState, type JSX } from 'react';
import { Alert, Button, Card, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAirportsByIcao } from '@/api/catalog';
import { useFlights } from '@/api/flights';
import { useSlots, type SlotRow } from '@/api/slots';
import { EmptyState, Mono, UtcTime, GenericStatusTag } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

import { ScrDrawer } from './ScrDrawer';
import { SlotAnswerModal } from './SlotAnswerModal';
import { SlotFormModal } from './SlotFormModal';

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

  const [formOpen, setFormOpen] = useState(false);
  const [scrSlot, setScrSlot] = useState<SlotRow | null>(null);
  const [answerSlot, setAnswerSlot] = useState<SlotRow | null>(null);

  const slots = useSlots({});
  const rows = slots.data?.data ?? [];

  // Номер рейса и название аэропорта — из справочников, а не из строки слота:
  // слот хранит связь, а не копию названия.
  const flights = useFlights({});
  const flightNumber = new Map(
    (flights.data?.data ?? []).map((flight) => [flight.id, flight.number]),
  );
  const airports = useAirportsByIcao(rows.map((row) => row.airportIcao));

  const columns: DataColumns<SlotRow> = [
    {
      title: t('flight.airport'), dataIndex: 'airportIcao', width: 190,
      render: (value: string) => (
        <Space direction="vertical" size={0}>
          <Mono>{value}</Mono>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {airports[value]?.name.ru}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('flight.number'), dataIndex: 'flightId', width: 120,
      render: (value: string) => (
        <Link to={`/flights/${value}`}>
          <Mono>{flightNumber.get(value) ?? value}</Mono>
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
        return <GenericStatusTag token={TOKEN[value] ?? 'neutral'} label={t(`slotStatus.${value}`)} />;
      },
    },
    {
      title: t('slots.messageRef'), dataIndex: 'messageRef', width: 200,
      render: (value: string | null) =>
        value ? <Mono>{value}</Mono> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('slots.comment'), dataIndex: 'comment', ellipsis: true,
      render: (value: string | null) =>
        value ? value : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 230, fixed: 'right',
      render: (_, row) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => { setScrSlot(row); }}>
            {t('slots.buildScr')}
          </Button>
          {/* Ответ применяют один раз: подтверждённый слот не переписывают. */}
          {row.status === 'requested' ? (
            <Button size="small" type="primary" onClick={() => { setAnswerSlot(row); }}>
              {t('slots.applyAnswer')}
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.slots')}</Typography.Title>
        <Button type="primary" onClick={() => { setFormOpen(true); }}>
          {t('slots.newRequest')}
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        message={t('slots.noPublicApiNotice')}
        description={t('slots.noPublicApiHint')}
      />

      {slots.isError ? <Alert type="error" showIcon message={t('common.error')} /> : null}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<SlotRow>
          size="small" rowKey="id" columns={columns} dataSource={rows}
          loading={slots.isFetching}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1290 }}
          locale={{ emptyText: <EmptyState description={t('slots.empty')} /> }}
        />
      </Card>

      <SlotFormModal open={formOpen} onClose={() => { setFormOpen(false); }} />
      <ScrDrawer slot={scrSlot} onClose={() => { setScrSlot(null); }} />
      <SlotAnswerModal slot={answerSlot} onClose={() => { setAnswerSlot(null); }} />
    </Space>
  );
}
