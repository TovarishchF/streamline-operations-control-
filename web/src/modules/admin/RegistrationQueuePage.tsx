import { useState, type JSX } from 'react';
import { App, Button, Card, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import {
  useDecideRegistration,
  useRegistrationRequests,
  type RegistrationRequestRow,
} from '@/api/auth';
import { ApiError } from '@/api/client';
import { SOC_COLORS } from '@/app/theme';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { DateText, EmptyState, Mono } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';

/**
 * Очередь заявок поставщиков `[ТЗ 4.3]` (ADR-037).
 *
 * Здесь принимается решение о закупке, а не о доступе: кому мы доверим
 * заправку борта и с кем будем судиться при срыве. Поэтому одобрение
 * заводит карточку поставщика и учётную запись разом, а отказ требует
 * причины — её сообщают заявителю.
 *
 * Заявок заказчиков здесь нет: они закрываются подтверждением почты.
 */
export function RegistrationQueuePage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const query = useRegistrationRequests();
  const approve = useDecideRegistration('approve');
  const reject = useDecideRegistration('reject');

  const [rejecting, setRejecting] = useState<RegistrationRequestRow | null>(null);
  const [reason, setReason] = useState('');

  const rows = query.data?.data ?? [];

  const decide = async (action: () => Promise<unknown>, done: string): Promise<void> => {
    try {
      await action();
      void message.success(done);
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  const columns: DataColumns<RegistrationRequestRow> = [
    {
      title: t('register.companyName'), dataIndex: 'companyName', ellipsis: true,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          {row.legalName ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.legalName}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('register.specializations'), dataIndex: 'specializations', width: 240,
      sortable: false,
      render: (value: string[]) => (
        <Space size={4} wrap>
          {value.map((code) => (
            <Tag key={code} style={{ margin: 0 }}>{t(`serviceCategory.${code}`, code)}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('register.coverageAirports'), dataIndex: 'coverageAirports', width: 170,
      sortable: false,
      render: (value: string[]) =>
        value.length > 0 ? <Mono>{value.join(' · ')}</Mono> : <span>—</span>,
    },
    {
      title: t('register.contactName'), dataIndex: 'contactName', width: 210,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <span>{value}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.email}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('register.submittedAt'), dataIndex: 'createdAt', width: 120,
      render: (value: string) => <DateText value={value} />,
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 210,
      render: (_, row) => (
        <Space size={6}>
          <Button
            size="small"
            type="primary"
            loading={approve.isPending}
            onClick={() => {
              void decide(
                () => approve.mutateAsync({ id: row.id }),
                t('register.approved'),
              );
            }}
          >
            {t('register.approve')}
          </Button>
          <Button
            size="small"
            danger
            onClick={() => {
              setReason('');
              setRejecting(row);
            }}
          >
            {t('register.reject')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.registrationQueue')}
      </Typography.Title>

      <QueryState query={query}>
        {() => (
          <Card size="small" styles={{ body: { padding: 0 } }}>
          <DataTable<RegistrationRequestRow>
            size="small" rowKey="id" columns={columns} dataSource={rows}
            pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1100 }}
            locale={{ emptyText: <EmptyState description={t('register.queueEmpty')} /> }}
            expandable={{
              expandedRowRender: (row) => (
                <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered>
                  <Descriptions.Item label={t('register.taxId')}>
                    {row.taxId || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('register.phone')}>
                    {row.phone || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('register.country')}>
                    {row.country || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('register.comment')} span={3}>
                    {row.comment || '—'}
                  </Descriptions.Item>
                </Descriptions>
              ),
            }}
          />
          </Card>
        )}
      </QueryState>

      <Modal
        open={rejecting !== null}
        title={t('register.rejectTitle')}
        okText={t('register.reject')}
        okButtonProps={{ danger: true, loading: reject.isPending }}
        cancelText={t('common.cancel')}
        onCancel={() => {
          setRejecting(null);
        }}
        onOk={() => {
          const target = rejecting;
          if (!target) return;
          void decide(
            () => reject.mutateAsync({ id: target.id, reason }),
            t('register.rejected'),
          ).then(() => {
            setRejecting(null);
          });
        }}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Typography.Text style={{ color: SOC_COLORS.inkSecondary }}>
            {t('register.rejectHint', { company: rejecting?.companyName ?? '' })}
          </Typography.Text>
          <Input.TextArea
            rows={3}
            value={reason}
            placeholder={t('register.rejectReason')}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Space>
      </Modal>
    </Space>
  );
}
