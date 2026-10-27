import type { JSX } from 'react';
import { Space, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { AuditEntry } from '@/api/types';
import { useFlightHistory } from '@/api/flights';
import { QueryState } from '@/shared/ui/QueryState';
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
      {entry.source === 'seed' || entry.source === 'system' ? (
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
 * История изменений рейса `[ТЗ 3.1.3]`: сам рейс, его заявки и документы.
 *
 * Записи генератора данных помечены `seed` и подписаны системой —
 * они не выдаются за действия людей (`CLAUDE.md § 4`).
 */
export function FlightHistoryTab({ flightId }: { flightId: string }): JSX.Element {
  const { t } = useTranslation();
  const history = useFlightHistory(flightId);

  const columns: DataColumns<AuditEntry> = [
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
      title: t('audit.entity'),
      dataIndex: 'entityType',
      width: 130,
      render: (value: string) => t(`auditEntity.${value}`, value),
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
    <QueryState query={history}>
      {(page) => (
        <DataTable<AuditEntry>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={page.data}
          pagination={false}
          scroll={{ x: 1000 }}
          locale={{ emptyText: <EmptyState description={t('audit.emptyForFlight')} /> }}
        />
      )}
    </QueryState>
  );
}
