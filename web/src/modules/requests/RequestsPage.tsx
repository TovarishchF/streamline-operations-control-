import { useState, type JSX } from 'react';
import { Alert, Button, Card, Input, Modal, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { FlightRequest } from '@/api/types';
import { CLIENT_BY_ID } from '@/mocks/counterparties';
import { FLIGHT_BY_ID, FLIGHT_REQUESTS } from '@/mocks/flights';
import { Can } from '@/shared/auth/Can';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  pending: 'progress', approved: 'done', rejected: 'critical',
};

/**
 * Очередь заявок от клиентов `[ТЗ 3.5.3]`.
 *
 * **Заявка становится рейсом только после подтверждения диспетчером**
 * (`SPEC.md § 2.2`). Клиент создаёт заявку, а не рейс: иначе в расписание
 * попадали бы неподтверждённые записи и планшет переставал бы отражать
 * реальную загрузку парка.
 */
export function RequestsPage(): JSX.Element {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [rejecting, setRejecting] = useState<FlightRequest | null>(null);

  const filtered = FLIGHT_REQUESTS.filter((request) =>
    filter === 'all' ? true : request.status === 'pending',
  );
  const pending = FLIGHT_REQUESTS.filter((r) => r.status === 'pending').length;

  const columns: ColumnsType<FlightRequest> = [
    {
      title: t('request.createdAt'), dataIndex: 'createdAt', width: 120,
      defaultSortOrder: 'descend',
      sorter: (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.client'), dataIndex: 'clientId', width: 220,
      render: (value: string) => (
        <Link to={`/clients/${value}`}>{CLIENT_BY_ID.get(value)?.name ?? value}</Link>
      ),
    },
    {
      title: t('flight.route'), key: 'route', width: 140,
      render: (_, row) => <Mono>{row.depIcao} → {row.arrIcao}</Mono>,
    },
    {
      title: t('request.requestedStd'), dataIndex: 'requestedStdUtc', width: 120,
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.pax'), dataIndex: 'paxCount', width: 80, align: 'right',
      render: (value: number) => <Mono>{value}</Mono>,
    },
    {
      title: t('request.comment'), dataIndex: 'comment', ellipsis: true,
      render: (value: string) => value || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('request.status'), dataIndex: 'status', width: 190,
      render: (value: string, row) => {
        const token = STATUS_TOKENS[TOKEN[value] ?? 'neutral'];
        return (
          <Space direction="vertical" size={2}>
            <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
              {t(`requestStatus.${value}`)}
            </Tag>
            {row.createdFlightId ? (
              <Link to={`/flights/${row.createdFlightId}`} style={{ fontSize: 12 }}>
                {FLIGHT_BY_ID.get(row.createdFlightId)?.number ?? row.createdFlightId}
              </Link>
            ) : null}
            {row.rejectionReason ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.rejectionReason}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: t('common.actions'), key: 'actions', width: 210, fixed: 'right',
      render: (_, row) =>
        row.status === 'pending' ? (
          <Can permission="request.approve">
            <Space size={4}>
              <Button size="small" type="primary">{t('request.approve')}</Button>
              <Button
                size="small" danger
                onClick={() => { setRejecting(row); }}
              >
                {t('request.reject')}
              </Button>
            </Space>
          </Can>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.requests')}</Typography.Title>

      {pending > 0 ? (
        <Alert
          type="info"
          showIcon
          message={t('request.pendingCount', { count: pending })}
          description={t('request.approvalHint')}
        />
      ) : null}

      <Segmented
        value={filter}
        onChange={(value) => { setFilter(value as 'pending' | 'all'); }}
        options={[
          { label: t('request.pendingOnly'), value: 'pending' },
          { label: t('common.all'), value: 'all' },
        ]}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<FlightRequest>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={false} scroll={{ x: 1150 }}
          locale={{ emptyText: <EmptyState description={t('request.empty')} /> }}
        />
      </Card>

      <Modal
        open={rejecting !== null}
        title={t('request.rejectTitle')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => { setRejecting(null); }}
        onOk={() => { setRejecting(null); }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('request.rejectHint')}</Typography.Text>
          <Input.TextArea rows={3} placeholder={t('request.rejectPlaceholder')} />
        </Space>
      </Modal>
    </Space>
  );
}
