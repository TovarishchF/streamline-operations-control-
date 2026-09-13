import type { JSX } from 'react';
import { Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';

import type { AuditEntry } from '@/api/types';
import { AUDIT } from '@/mocks/admin';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';

/**
 * Различие «было → стало» считается на отображении, а не хранится готовым
 * текстом (`DOMAIN.md § 8`): хранится JSONB, текст строится здесь.
 */
export function AuditDiff({ entry }: { entry: AuditEntry }): JSX.Element | null {
  const before = (entry.before ?? {}) as Record<string, unknown>;
  const after = (entry.after ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  if (keys.length === 0) return null;

  return (
    <Space direction="vertical" size={0}>
      {keys.map((key) => (
        <Typography.Text key={key} style={{ fontSize: 12 }}>
          <Mono>{key}</Mono>:{' '}
          {key in before ? (
            <Typography.Text delete type="secondary">
              {String(before[key])}
            </Typography.Text>
          ) : null}
          {key in before && key in after ? ' → ' : null}
          {key in after ? <Typography.Text strong>{String(after[key])}</Typography.Text> : null}
        </Typography.Text>
      ))}
    </Space>
  );
}

/** Автор записи с пометкой происхождения (`CLAUDE.md § 4`). */
export function AuditActor({ entry }: { entry: AuditEntry }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Space size={6}>
      <span>{entry.actorName}</span>
      {entry.source === 'seed' ? (
        <Tooltip title={t('audit.seedHint')}>
          <Tag color="purple" style={{ margin: 0 }}>
            {t('audit.seed')}
          </Tag>
        </Tooltip>
      ) : entry.source === 'system' ? (
        <Tag style={{ margin: 0 }}>{t('audit.system')}</Tag>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t(`roles.${entry.actorRole}`)}
        </Typography.Text>
      )}
    </Space>
  );
}

/**
 * История изменений рейса `[ТЗ 3.1.3]`.
 *
 * Записи от демонстрационного генератора помечены `seed` и визуально
 * отличаются — они не выдаются за действия людей (`CLAUDE.md § 4`).
 */
export function FlightHistoryTab({ flightId }: { flightId: string }): JSX.Element {
  const { t } = useTranslation();
  const suffix = flightId.slice(-3);
  const entries = AUDIT.filter(
    (entry) => entry.entityId === flightId || entry.entityId.startsWith(`so_${suffix}`),
  );

  const columns: ColumnsType<AuditEntry> = [
    {
      title: t('audit.ts'),
      dataIndex: 'ts',
      width: 110,
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    {
      title: t('audit.actor'),
      key: 'actor',
      width: 210,
      render: (_, row) => <AuditActor entry={row} />,
    },
    {
      title: t('audit.action'),
      dataIndex: 'action',
      width: 200,
      render: (value: string) => t(`auditAction.${value}`, value),
    },
    { title: t('audit.diff'), key: 'diff', render: (_, row) => <AuditDiff entry={row} /> },
    {
      title: t('audit.comment'),
      dataIndex: 'comment',
      ellipsis: true,
      render: (value: string | null) =>
        value ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <Table<AuditEntry>
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={entries}
      pagination={false}
      scroll={{ x: 900 }}
      rowClassName={(row) => (row.source === 'seed' ? 'soc-row-seed' : '')}
      locale={{ emptyText: <EmptyState description={t('audit.emptyForFlight')} /> }}
    />
  );
}
