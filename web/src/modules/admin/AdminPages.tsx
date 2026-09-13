import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, Input, InputNumber, Row, Select, Space, Table,
  Tag, Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';

import type { SlaRule, User } from '@/api/types';
import { SLA_RULES, USERS } from '@/mocks/admin';
import { VENDORS } from '@/mocks/counterparties';
import { SERVICE_CATEGORIES } from '@/mocks/reference';
import { EmptyState, Mono } from '@/shared/ui/primitives';

/** Пользователи и роли `[ТЗ 4.3]`. */
export function UsersPage(): JSX.Element {
  const { t } = useTranslation();

  const columns: ColumnsType<User> = [
    { title: t('admin.name'), dataIndex: 'name', width: 200 },
    { title: t('admin.email'), dataIndex: 'email', ellipsis: true,
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
        <Col><Button type="primary">{t('admin.addUser')}</Button></Col>
      </Row>

      <Alert type="info" showIcon message={t('admin.permissionsNotice')} />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<User>
          size="small" rowKey="id" columns={columns} dataSource={USERS}
          pagination={false} scroll={{ x: 900 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}

/**
 * Правила SLA.
 *
 * G-39: института SLA в оригинальном ТЗ нет — упомянуты только «штрафы
 * за нарушение SLA» в целях. Значения по умолчанию заданы нами и подлежат
 * замене на реальные сроки из договоров заказчика.
 */
export function SlaPage(): JSX.Element {
  const { t } = useTranslation();

  const columns: ColumnsType<SlaRule> = [
    {
      title: t('sla.scope'), key: 'scope', width: 280,
      render: (_, row) =>
        row.scope.vendorId ? (
          <Space size={4}>
            <Tag color="blue">{t('sla.byVendor')}</Tag>
            <span>{VENDORS.find((v) => v.id === row.scope.vendorId)?.name}</span>
          </Space>
        ) : row.scope.category ? (
          <Space size={4}>
            <Tag>{t('sla.byCategory')}</Tag>
            <span>{t(`serviceCategory.${row.scope.category}`)}</span>
          </Space>
        ) : (
          <Tag>{t('sla.default')}</Tag>
        ),
    },
    {
      title: t('sla.confirmMinutes'), dataIndex: 'confirmMinutes', width: 180, align: 'right',
      render: (value: number) => <Mono>{value} {t('common.minutes')}</Mono>,
    },
    {
      title: t('sla.completionMinutes'), dataIndex: 'completionMinutes', width: 180, align: 'right',
      render: (value: number) => <Mono>{value} {t('common.minutes')}</Mono>,
    },
    {
      title: t('sla.penalty'), key: 'penalty', width: 160,
      render: (_, row) =>
        row.penalty?.kind === 'none' || !row.penalty ? (
          <Typography.Text type="secondary">{t('sla.noPenalty')}</Typography.Text>
        ) : (
          <Mono>
            {Number.parseFloat(row.penalty.value ?? '0').toFixed(0)}
            {row.penalty.kind === 'percent' ? ' %' : ''}
          </Mono>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.sla')}</Typography.Title>

      <Alert type="warning" showIcon message={t('sla.defaultsNotice')} description={t('sla.defaultsHint')} />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<SlaRule>
          size="small" rowKey="id" columns={columns} dataSource={SLA_RULES}
          pagination={false} scroll={{ x: 800 }}
        />
      </Card>

      <Card size="small" title={t('sla.weights')}>
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('sla.weightsHint')}
          </Typography.Text>
          <Space size={16} wrap>
            {[
              ['onTimeConfirm', '0.30'],
              ['slaCompliance', '0.30'],
              ['billing', '0.20'],
              ['quality', '0.20'],
            ].map(([key, value]) => (
              <Space key={key} direction="vertical" size={0}>
                <Typography.Text style={{ fontSize: 12 }}>{t(`sla.weight_${String(key)}`)}</Typography.Text>
                <InputNumber value={Number(value)} step={0.05} min={0} max={1} style={{ width: 110 }} />
              </Space>
            ))}
          </Space>
        </Space>
      </Card>
    </Space>
  );
}

/**
 * Управление демонстрационными данными.
 *
 * `CLAUDE.md § 4`: `seed_demo` доступна только при `DEMO_DATA=true`.
 * ADR-016: `--purge` удаляет только записи с `is_demo`, и это возможно
 * потому, что ссылки «реальное → демо» запрещены на уровне БД.
 */
export function DemoDataPage(): JSX.Element {
  const { t } = useTranslation();
  const [seed, setSeed] = useState('20260913');

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.demoData')}</Typography.Title>

      <Alert type="warning" showIcon message={t('demo.pageNotice')} description={t('demo.pageHint')} />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={t('demo.generation')}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text style={{ fontSize: 12 }}>{t('demo.seed')}</Typography.Text>
                <Input
                  value={seed}
                  onChange={(e) => { setSeed(e.target.value); }}
                  style={{ maxWidth: 240, fontFamily: "'JetBrains Mono', monospace" }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('demo.seedHint')}
                </Typography.Text>
              </Space>
              <Space size={8} wrap>
                <Button type="primary">{t('demo.generate')}</Button>
                <Button>{t('demo.reset')}</Button>
                <Button danger>{t('demo.purge')}</Button>
              </Space>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card size="small" title={t('demo.autoConfirm')}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('demo.autoConfirmHint')}
              </Typography.Text>
              <Space direction="vertical" size={4}>
                <Typography.Text style={{ fontSize: 12 }}>{t('demo.autoConfirmPercent')}</Typography.Text>
                <InputNumber defaultValue={60} min={0} max={100} addonAfter="%" style={{ width: 150 }} />
              </Space>
              <Divider style={{ margin: '4px 0' }} />
              <Descriptions size="small" column={1}>
                <Descriptions.Item label={t('demo.markerEnv')}>
                  <Mono>DEMO_DATA=true</Mono>
                </Descriptions.Item>
                <Descriptions.Item label={t('demo.markerControl')}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('demo.markerControlHint')}
                  </Typography.Text>
                </Descriptions.Item>
              </Descriptions>
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

/** Спецификация REST API `[ТЗ 4.2]`. */
export function ApiDocsPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.apiDocs')}</Typography.Title>

      <Alert
        type="info"
        showIcon
        message={t('api.contractNotice')}
        description={t('api.contractHint')}
      />

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

export { SERVICE_CATEGORIES, Select };
