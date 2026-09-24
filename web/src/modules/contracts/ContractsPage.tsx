import { useState, type JSX } from 'react';
import { Alert, Button, Card, Col, Row, Segmented, Space, Tooltip, Typography } from 'antd';
import { PaperClipOutlined, PlusOutlined } from '@ant-design/icons';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useContracts, useVendors, type VendorContractRow } from '@/api/counterparties';
import { Can } from '@/shared/auth/Can';
import { useClock } from '@/shared/clock/useClock';
import { DateText, EmptyState, Mono, GenericStatusTag } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { ContractFormModal } from './ContractFormModal';

const TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  active: 'done', expiring: 'warning', expired: 'critical', terminated: 'cancelled',
};

/**
 * Договоры с поставщиками `[ТЗ 3.3.3]`.
 *
 * Светофор сроков: действует / истекает / истёк. Фильтр по умолчанию —
 * «требуют внимания» (`SPEC.md § 6.3`): администратору нужен список того,
 * чем заняться, а не полный реестр.
 *
 * Статус приходит с сервера и вычисляется там от дат (G-42): хранимый
 * статус неизбежно разъезжается с датами, потому что его некому
 * пересчитывать в полночь по каждой записи.
 *
 * Уведомления за 30, 15 и 7 дней ставятся планировщиком с ключом
 * идемпотентности `contractId + порог` — повторно одно и то же уведомление
 * не создаётся.
 */
export function ContractsPage(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [adding, setAdding] = useState(false);

  // Реестр запрашивается целиком: фильтр «требуют внимания» — это два
  // статуса из четырёх, и два запроса вместо одного ничего не экономят.
  const query = useContracts({});
  const contracts = query.data?.data ?? [];

  const vendorNames = new Map(
    (useVendors().data?.data ?? []).map((vendor) => [vendor.id, vendor.name]),
  );

  const filtered =
    filter === 'all'
      ? contracts
      : contracts.filter(
          (contract) => contract.status === 'expiring' || contract.status === 'expired',
        );

  const expiring = contracts.filter((c) => c.status === 'expiring').length;
  const expired = contracts.filter((c) => c.status === 'expired').length;

  const daysLeft = (validTo: string): number =>
    Math.round((new Date(validTo).getTime() - nowUtc.getTime()) / 86_400_000);

  const columns: DataColumns<VendorContractRow> = [
    {
      title: t('contract.number'), dataIndex: 'number', width: 170, fixed: 'left',
      render: (value: string, row) => (
        <Space size={6}>
          <Mono>{value}</Mono>
          {row.attachments.length > 0 ? (
            <Tooltip title={t('contract.attachmentsCount', { count: row.attachments.length })}>
              <PaperClipOutlined />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('service.vendor'), dataIndex: 'vendorId', ellipsis: true,
      render: (value: string) => (
        <Link to={`/vendors/${value}`}>{vendorNames.get(value) ?? value}</Link>
      ),
    },
    {
      title: t('contract.validFrom'), dataIndex: 'validFrom', width: 120,
      render: (value: string) => <DateText value={value} />,
    },
    {
      title: t('contract.validTo'), dataIndex: 'validTo', width: 170,
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.validTo.localeCompare(b.validTo),
      render: (value: string, row) => {
        const days = daysLeft(value);
        return (
          <Space size={6}>
            <DateText value={value} />
            {row.status !== 'active' ? (
              <Typography.Text
                style={{
                  fontSize: 12,
                  color: days < 0 ? STATUS_TOKENS.critical.color : STATUS_TOKENS.warning.color,
                }}
              >
                {days < 0
                  ? t('contract.expiredDaysAgo', { days: Math.abs(days) })
                  : t('contract.daysLeft', { days })}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: t('contract.currency'), dataIndex: 'currency', width: 90,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('client.paymentTerms'), key: 'terms', width: 170,
      render: (_, row) =>
        `${t(`paymentMode.${row.paymentTerms.mode}`)}, ${String(row.paymentTerms.deferDays)} ${t('common.days')}`,
    },
    {
      title: t('contract.scan'), key: 'files', width: 210,
      render: (_, row) =>
        row.attachments.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            {row.attachments.map((attachment) => (
              <Typography.Link
                key={attachment.id}
                href={attachment.downloadUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12 }}
                ellipsis
              >
                {attachment.fileName}
              </Typography.Link>
            ))}
          </Space>
        ),
    },
    {
      title: t('contract.status'), dataIndex: 'status', width: 140,
      render: (value: string) => {
        return <GenericStatusTag token={TOKEN[value] ?? 'neutral'} label={t(`contractStatus.${value}`)} />;
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.contracts')}</Typography.Title>
        </Col>
        <Col>
          <Can permission="contract.edit">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('contract.add')}
            </Button>
          </Can>
        </Col>
      </Row>

      {expired > 0 || expiring > 0 ? (
        <Alert
          type={expired > 0 ? 'error' : 'warning'}
          showIcon
          message={t('contract.attentionNotice', { expiring, expired })}
          description={t('contract.attentionHint')}
        />
      ) : null}

      <Segmented
        value={filter}
        onChange={(value) => { setFilter(value as 'attention' | 'all'); }}
        options={[
          { label: t('contract.needsAttention'), value: 'attention' },
          { label: t('common.all'), value: 'all' },
        ]}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {() => (
            <DataTable<VendorContractRow>
              size="small" rowKey="id" columns={columns} dataSource={filtered}
              pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1200 }}
              locale={{ emptyText: <EmptyState description={t('contract.noneNeedAttention')} /> }}
            />
          )}
        </QueryState>
      </Card>

      <ContractFormModal
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Space>
  );
}
