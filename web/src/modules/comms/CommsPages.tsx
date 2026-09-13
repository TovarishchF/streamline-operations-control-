import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, Drawer, List, Segmented, Space, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { DownloadOutlined, RedoOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import type { InboxMessage, OutboxMessage } from '@/api/types';
import { INBOX, OUTBOX } from '@/mocks/comms';
import { EmptyState, Mono, UtcTime } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const OUTBOX_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  queued: 'neutral', sent: 'progress', delivered: 'done', failed: 'critical',
};

/**
 * Исходящие `[ТЗ 3.5.2]`.
 *
 * Сообщение хранится целиком: канал, получатели, тема, отрендеренное тело,
 * вложения, статус и число попыток. В режиме `stub` внешний вызов не
 * выполняется — бейдж канала показывает **фактический режим** и не выдаёт
 * заглушку за отправку (`CLAUDE.md § 4`).
 */
export function OutboxPage(): JSX.Element {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<OutboxMessage | null>(null);
  const [status, setStatus] = useState<string | undefined>();

  const filtered = OUTBOX.filter((m) => !status || m.status === status);

  const columns: DataColumns<OutboxMessage> = [
    {
      title: t('comms.channel'), dataIndex: 'channel', width: 150,
      render: (value: string, row) => (
        <Space size={4}>
          <Tag style={{ margin: 0 }}>{t(`channel.${value}`)}</Tag>
          <Tag color="purple" style={{ margin: 0 }}>{row.channelMode ?? 'stub'}</Tag>
        </Space>
      ),
    },
    {
      title: t('comms.to'), key: 'to', width: 220, ellipsis: true,
      render: (_, row) => row.to.map((x) => x.name).join(', '),
    },
    { title: t('comms.subject'), dataIndex: 'subject', ellipsis: true },
    {
      title: t('comms.status'), dataIndex: 'status', width: 140,
      render: (value: string, row) => {
        const token = STATUS_TOKENS[OUTBOX_TOKEN[value] ?? 'neutral'];
        return (
          <Space size={4}>
            <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
              {t(`outboxStatus.${value}`)}
            </Tag>
            {(row.attempts ?? 1) > 1 ? <Mono>×{row.attempts}</Mono> : null}
          </Space>
        );
      },
    },
    {
      title: t('comms.sentAt'), dataIndex: 'sentAt', width: 110,
      render: (value: string | null) => <UtcTime value={value} withDate />,
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 170,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" onClick={() => { setPreview(row); }}>{t('common.open')}</Button>
          {row.status === 'failed' ? (
            <Button size="small" icon={<RedoOutlined />}>{t('comms.retry')}</Button>
          ) : null}
          {row.emlUrl ? <Button size="small" icon={<DownloadOutlined />}>eml</Button> : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.outbox')}</Typography.Title>

      <Alert type="info" showIcon message={t('comms.stubNotice')} />

      <Segmented
        value={status ?? 'all'}
        onChange={(value) => { setStatus(value === 'all' ? undefined : (value)); }}
        options={[
          { label: t('common.all'), value: 'all' },
          ...Object.keys(OUTBOX_TOKEN).map((code) => ({ label: t(`outboxStatus.${code}`), value: code })),
        ]}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<OutboxMessage>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1000 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>

      <Drawer
        open={preview !== null}
        width={620}
        title={t('comms.messagePreview')}
        onClose={() => { setPreview(null); }}
      >
        {preview ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space size={6} wrap>
              <Tag>{t(`channel.${preview.channel}`)}</Tag>
              <Tag color="purple">{preview.channelMode ?? 'stub'}</Tag>
              <Tag>{t(`outboxStatus.${preview.status}`)}</Tag>
            </Space>
            <Typography.Text strong>{preview.subject}</Typography.Text>
            <Typography.Text type="secondary">
              {preview.to.map((x) => `${x.name ?? ''} <${x.address ?? ''}>`).join(', ')}
            </Typography.Text>
            <Card size="small" styles={{ body: { padding: 12 } }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                {preview.body}
              </pre>
            </Card>
            {preview.lastError ? (
              <Alert type="error" showIcon message={preview.lastError} />
            ) : null}
            {(preview.attachments?.length ?? 0) > 0 ? (
              <List
                size="small" bordered header={t('flight.attachments')}
                dataSource={preview.attachments ?? []}
                renderItem={(item) => <List.Item><Mono>{item.fileName}</Mono></List.Item>}
              />
            ) : null}
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}

/**
 * Входящие `[ТЗ 3.2.2]`.
 *
 * Нераспознанные письма попадают в очередь ручного разбора — это **штатный
 * сценарий, а не ошибка** (`INTEGRATIONS.md § 3.3`). Полностью автоматического
 * разбора не будет; цель — снять 60–70 % рутины.
 */
export function InboxPage(): JSX.Element {
  const { t } = useTranslation();
  const [unrecognizedOnly, setUnrecognizedOnly] = useState(false);

  const filtered = INBOX.filter((m) => !unrecognizedOnly || !m.recognized);
  const unrecognized = INBOX.filter((m) => !m.recognized).length;

  const columns: DataColumns<InboxMessage> = [
    {
      title: t('comms.receivedAt'), dataIndex: 'receivedAt', width: 110,
      render: (value: string) => <UtcTime value={value} withDate />,
    },
    { title: t('comms.from'), dataIndex: 'from', width: 260, ellipsis: true,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('comms.subject'), dataIndex: 'subject', ellipsis: true },
    {
      title: t('comms.recognized'), dataIndex: 'recognized', width: 190,
      render: (value: boolean, row) =>
        value ? (
          <Space size={4}>
            <Tag color="green" style={{ margin: 0 }}>{t('comms.recognizedYes')}</Tag>
            {row.suggestedAction ? <Tag style={{ margin: 0 }}>{t(`inboxAction.${row.suggestedAction}`)}</Tag> : null}
          </Space>
        ) : (
          <Tag color="orange" style={{ margin: 0 }}>{t('comms.needsManual')}</Tag>
        ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 150,
      render: (_, row) =>
        row.appliedAt ? (
          <Typography.Text type="secondary">{t('comms.applied')}</Typography.Text>
        ) : row.recognized ? (
          <Button size="small" type="primary">{t('comms.apply')}</Button>
        ) : (
          <Button size="small">{t('comms.processManually')}</Button>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.inbox')}</Typography.Title>

      {unrecognized > 0 ? (
        <Alert
          type="info" showIcon
          message={t('comms.unrecognizedCount', { count: unrecognized })}
          description={t('comms.unrecognizedHint')}
        />
      ) : null}

      <Tag.CheckableTag checked={unrecognizedOnly} onChange={setUnrecognizedOnly}>
        {t('comms.unrecognizedOnly')}
      </Tag.CheckableTag>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<InboxMessage>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={false} scroll={{ x: 950 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
