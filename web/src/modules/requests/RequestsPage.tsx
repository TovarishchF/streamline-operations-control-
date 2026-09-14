import { useState, type JSX } from 'react';
import { Alert, App, Button, Card, Input, Modal, Segmented, Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useClients } from '@/api/counterparties';
import {
  useApproveRequest,
  useFlightRequests,
  useRejectRequest,
  type FlightRequest,
} from '@/api/flights';
import { QueryState } from '@/shared/ui/QueryState';
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
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [rejectReason, setRejectReason] = useState('');
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const query = useFlightRequests();
  const requests = query.data?.data ?? [];
  const clients = useClients().data?.data ?? [];
  const approveRequest = useApproveRequest();
  const rejectRequest = useRejectRequest();
  const [rejecting, setRejecting] = useState<FlightRequest | null>(null);

  const filtered = requests.filter((request) =>
    filter === 'all' ? true : request.status === 'pending',
  );
  const pending = requests.filter((r) => r.status === 'pending').length;

  const columns: DataColumns<FlightRequest> = [
    {
      title: t('request.createdAt'), dataIndex: 'createdAt', width: 120,
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('flight.client'), dataIndex: 'clientId', width: 220,
      render: (value: string) => (
        <Link to={`/clients/${value}`}>
          {clients.find((client) => client.id === value)?.name ?? value}
        </Link>
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
                {t('request.createdFlight')}
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
      title: t('common.actions'), key: 'actions', sortable: false, width: 210, fixed: 'right',
      render: (_, row) =>
        row.status === 'pending' ? (
          <Can permission="request.approve">
            <Space size={4}>
              <Button
                size="small"
                type="primary"
                loading={approveRequest.isPending}
                onClick={() => {
                  approveRequest.mutate(row.id, {
                    onSuccess: (flight) => {
                      void message.success(
                        t('request.approved', { number: flight.number }),
                      );
                      navigate(`/flights/${flight.id}`);
                    },
                    onError: (cause: unknown) => {
                      void message.error(
                        cause instanceof ApiError
                          ? cause.message
                          : t('request.approveFailed'),
                      );
                    },
                  });
                }}
              >
                {t('request.approve')}
              </Button>
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
        <QueryState query={query}>
          {() => (
            <DataTable<FlightRequest>
              size="small" rowKey="id" columns={columns} dataSource={filtered}
              pagination={false} scroll={{ x: 1150 }}
              locale={{ emptyText: <EmptyState description={t('request.empty')} /> }}
            />
          )}
        </QueryState>
      </Card>

      <Modal
        open={rejecting !== null}
        title={t('request.rejectTitle')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => { setRejecting(null); setRejectReason(''); }}
        okButtonProps={{ disabled: rejectReason.trim().length === 0 }}
        onOk={() => {
          if (!rejecting) return;
          rejectRequest.mutate(
            { id: rejecting.id, reason: rejectReason.trim() },
            {
              onSuccess: () => {
                void message.success(t('request.rejected'));
                setRejecting(null);
                setRejectReason('');
              },
              onError: (cause: unknown) => {
                void message.error(
                  cause instanceof ApiError ? cause.message : t('request.approveFailed'),
                );
              },
            },
          );
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('request.rejectHint')}</Typography.Text>
          <Input.TextArea
            rows={3}
            placeholder={t('request.rejectPlaceholder')}
            value={rejectReason}
            onChange={(event) => { setRejectReason(event.target.value); }}
          />
        </Space>
      </Modal>
    </Space>
  );
}
