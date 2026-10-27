import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Descriptions, Input, Row, Space, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { useSampleDataAction, useUsers, type SampleDataResult } from '@/api/admin';
import { ApiError } from '@/api/client';
import type { User } from '@/api/types';
import { EmptyState, Mono } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';

import { UserFormModal } from './UserFormModal';

/** Пользователи и роли `[ТЗ 4.3]`. */
export function UsersPage(): JSX.Element {
  const { t } = useTranslation();
  const query = useUsers();
  const [formOpen, setFormOpen] = useState(false);

  const columns: DataColumns<User> = [
    { title: t('admin.name'), dataIndex: 'name', filterable: 'text', width: 200 },
    { title: t('admin.email'), dataIndex: 'email', filterable: 'text', ellipsis: true,
      render: (value: string) => <Mono>{value}</Mono> },
    { title: t('admin.role'), dataIndex: 'role', width: 160,
      render: (value: string) => <Tag>{t(`roles.${value}`)}</Tag> },
    {
      title: t('admin.twoFactor'), dataIndex: 'twoFactorEnabled', width: 130,
      render: (value: boolean, row) => (
        <Space size={4}>
          <Tag color={value ? 'green' : 'default'} style={{ margin: 0 }}>
            {value ? t('common.yes') : t('common.no')}
          </Tag>
          {/* ADR-013: 2FA обязательна для admin и finance */}
          {!value && (row.role === 'admin' || row.role === 'finance') ? (
            <Tag color="red" style={{ margin: 0 }}>{t('admin.twoFactorRequired')}</Tag>
          ) : null}
        </Space>
      ),
    },
    { title: t('admin.timezone'), dataIndex: 'timezone', width: 160,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Mono>{value}</Mono>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t(`timezoneMode.${row.timezoneMode ?? 'utc'}`)}
          </Typography.Text>
        </Space>
      ) },
    { title: t('common.status'), dataIndex: 'isActive', width: 110,
      render: (value: boolean) => (
        <Tag color={value ? 'green' : 'default'}>{value ? t('common.active') : t('common.inactive')}</Tag>
      ) },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]}>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.users')}</Typography.Title>
        </Col>
        <Col>
          <Button type="primary" onClick={() => { setFormOpen(true); }}>
            {t('admin.addUser')}
          </Button>
        </Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<User>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={false} scroll={{ x: 900 }}
              locale={{ emptyText: <EmptyState /> }}
            />
          )}
        </QueryState>
      </Card>

      <UserFormModal open={formOpen} onClose={() => { setFormOpen(false); }} />
    </Space>
  );
}

/**
 * Генератор данных `[ТЗ этап 2]`.
 *
 * `CLAUDE.md § 4`: `seed_sample` доступна только при `SAMPLE_DATA=true`.
 * ADR-016: `--purge` удаляет только записи генератора, и это возможно
 * потому, что ссылки «введённая запись → запись генератора» запрещены на
 * уровне БД. Экран выводится в меню только в режиме генератора.
 */
export function SampleDataPage(): JSX.Element {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const [seed, setSeed] = useState('20260913');
  const [result, setResult] = useState<SampleDataResult | null>(null);

  const generate = useSampleDataAction('generate');
  const reset = useSampleDataAction('reset');
  const purge = useSampleDataAction('purge');
  const busy = generate.isPending || reset.isPending || purge.isPending;

  const run = async (
    action: ReturnType<typeof useSampleDataAction>,
    label: string,
  ): Promise<void> => {
    try {
      setResult(await action.mutateAsync(Number(seed) || undefined));
      void message.success(label);
    } catch (error) {
      // Отказ объясняет сам сервер: при выключенном генераторе действие
      // запрещено, и подменять это сообщение своим значило бы скрыть причину.
      void message.error(
        error instanceof ApiError ? error.message : t('common.saveFailed'),
      );
    }
  };

  /** Необратимое действие подтверждается: набор уходит из системы целиком. */
  const confirmAnd = (
    action: ReturnType<typeof useSampleDataAction>,
    title: string,
    label: string,
  ): void => {
    modal.confirm({
      title,
      content: t('sampleData.confirmHint'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => run(action, label),
    });
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.sampleData')}</Typography.Title>

      <Card size="small" title={t('sampleData.generation')} style={{ maxWidth: 720 }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Typography.Text style={{ fontSize: 12 }}>{t('sampleData.seed')}</Typography.Text>
            <Input
              value={seed}
              onChange={(e) => { setSeed(e.target.value); }}
              style={{ maxWidth: 240, fontFamily: "'JetBrains Mono', monospace" }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('sampleData.seedHint')}
            </Typography.Text>
          </Space>
          <Space size={8} wrap>
            <Button
              type="primary"
              loading={generate.isPending}
              disabled={busy && !generate.isPending}
              onClick={() => { void run(generate, t('sampleData.generated')); }}
            >
              {t('sampleData.generate')}
            </Button>
            <Button
              loading={reset.isPending}
              disabled={busy && !reset.isPending}
              onClick={() => {
                confirmAnd(reset, t('sampleData.resetConfirm'), t('sampleData.wasReset'));
              }}
            >
              {t('sampleData.reset')}
            </Button>
            <Button
              danger
              loading={purge.isPending}
              disabled={busy && !purge.isPending}
              onClick={() => {
                confirmAnd(purge, t('sampleData.purgeConfirm'), t('sampleData.purged'));
              }}
            >
              {t('sampleData.purge')}
            </Button>
          </Space>

          {result ? (
            <Alert
              type="success"
              showIcon
              closable
              message={t(`sampleData.done_${result.action}`)}
              description={
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={10} wrap>
                    {Object.entries(result.counts).map(([name, count]) => (
                      <Typography.Text key={name} style={{ fontSize: 12 }}>
                        {name}: <Mono>{count}</Mono>
                      </Typography.Text>
                    ))}
                  </Space>
                  {result.message ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {result.message}
                    </Typography.Text>
                  ) : null}
                </Space>
              }
            />
          ) : null}
        </Space>
      </Card>
    </Space>
  );
}

/** Спецификация REST API `[ТЗ 4.2]`. */
export function ApiDocsPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.apiDocs')}</Typography.Title>

      <Card size="small">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label={t('api.spec')}>
            <Mono>openapi.yaml</Mono> · OpenAPI 3.1.0
          </Descriptions.Item>
          <Descriptions.Item label={t('api.basePath')}>
            <Mono>/api/v1</Mono>
          </Descriptions.Item>
          <Descriptions.Item label={t('api.docs')}>
            <Typography.Link href="/api/docs" target="_blank" rel="noreferrer">
              /api/docs (Redoc)
            </Typography.Link>
          </Descriptions.Item>
          <Descriptions.Item label={t('api.auth')}>
            JWT (access 15 {t('common.minutesShort')}, refresh 7 {t('common.days')})
          </Descriptions.Item>
          <Descriptions.Item label={t('api.idempotency')}>
            <Mono>Idempotency-Key</Mono> — {t('api.idempotencyHint')}
          </Descriptions.Item>
          <Descriptions.Item label={t('api.types')}>
            <Mono>make api-types</Mono> → <Mono>shared/api-types.ts</Mono>
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}
