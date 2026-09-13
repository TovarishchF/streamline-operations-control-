import { useMemo, useState, type JSX } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { ExportOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { useAuditEntries, type AuditEntryRow } from '@/api/admin';
import { AuditActor, AuditDiff } from '@/modules/flights/FlightHistoryTab';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';

const ENTITY_TYPES = [
  'flight', 'service_order', 'vendor', 'client', 'contract', 'tariff', 'quote',
  'invoice', 'payable', 'payment', 'reconciliation', 'user', 'settings', 'crew',
  'aircraft', 'service', 'airport',
] as const;

/**
 * Журнал аудита `[ТЗ 4.3]`.
 *
 * Записи неизменяемы на уровне базы: изменение и удаление отклоняет триггер
 * (ADR-033). Экран доступен администратору и руководителю, остальным сервер
 * отвечает 403.
 *
 * Записи от демонстрационного генератора помечены `seed` и визуально
 * отличаются — они не выдаются за действия людей (`CLAUDE.md § 4`).
 */
export function AuditPage(): JSX.Element {
  const { t } = useTranslation();
  const [entityType, setEntityType] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [page, setPage] = useState(1);

  // Тип сущности фильтрует сервер, происхождение — клиент: журнал листается
  // постранично, и добавлять эндпоинту параметр ради трёх значений не нужно.
  const query = useAuditEntries({
    ...(entityType ? { entityType } : {}),
    page,
    perPage: 25,
  });

  const rows = useMemo(() => {
    const data = query.data?.data ?? [];
    return source ? data.filter((entry) => entry.source === source) : data;
  }, [query.data, source]);

  const columns: DataColumns<AuditEntryRow> = [
    {
      title: t('audit.ts'), dataIndex: 'ts', width: 120, fixed: 'left',
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.ts.localeCompare(b.ts),
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    { title: t('audit.actor'), key: 'actor', width: 220,
      render: (_, row) => <AuditActor entry={row} /> },
    {
      title: t('audit.entity'), key: 'entity', width: 200,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{t(`auditEntity.${row.entityType}`)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <Mono>{row.entityId}</Mono>
          </Typography.Text>
        </Space>
      ),
    },
    { title: t('audit.action'), dataIndex: 'action', width: 200,
      render: (value: string) => t(`auditAction.${value}`, value) },
    { title: t('audit.diff'), key: 'diff', render: (_, row) => <AuditDiff entry={row} /> },
    { title: t('audit.comment'), dataIndex: 'comment', width: 260, ellipsis: true,
      render: (value: string | null) => value ?? <Typography.Text type="secondary">—</Typography.Text> },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]}>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.audit')}</Typography.Title>
        </Col>
        <Col>
          <Button icon={<ExportOutlined />}>{t('audit.export')}</Button>
        </Col>
      </Row>

      <Alert type="info" showIcon message={t('audit.immutableNotice')} />

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={8}>
            <Select
              allowClear style={{ width: '100%' }} placeholder={t('audit.entity')}
              value={entityType}
              onChange={(value: string | undefined) => {
                setEntityType(value);
                setPage(1);
              }}
              options={ENTITY_TYPES.map((code) => ({ value: code, label: t(`auditEntity.${code}`) }))}
            />
          </Col>
          <Col xs={12} md={6}>
            <Select
              allowClear style={{ width: '100%' }} placeholder={t('audit.source')}
              value={source} onChange={setSource}
              options={['user', 'system', 'seed'].map((code) => ({
                value: code, label: t(`auditSource.${code}`),
              }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<AuditEntryRow>
              size="small" rowKey="id" columns={columns} dataSource={rows}
              scroll={{ x: 1200 }}
              rowClassName={(row) => (row.source === 'seed' ? 'soc-row-seed' : '')}
              locale={{ emptyText: <EmptyState /> }}
              pagination={{
                size: 'small',
                current: paged.meta.page,
                pageSize: paged.meta.perPage,
                total: paged.meta.total,
                showSizeChanger: false,
                onChange: setPage,
              }}
            />
          )}
        </QueryState>
      </Card>
    </Space>
  );
}
