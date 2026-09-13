import { useMemo, type JSX } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Form, List, Row, Select, Space, Tag, Typography,
} from 'antd';
import { FileExcelOutlined, FilePdfOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { DataTable } from '@/shared/ui/DataTable';

import { REPORT_DEFINITIONS } from '@/mocks/admin';
import { RECEIVABLES_BUCKETS, PAYABLES_BUCKETS } from '@/mocks/billing';
import { CLIENTS, VENDORS } from '@/mocks/counterparties';
import { FLIGHT_LIST, MARGINS, SERVICE_ORDERS } from '@/mocks/flights';
import { EmptyState, MoneyText, Mono, PercentText, UtcTime } from '@/shared/ui/primitives';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

/** Каталог отчётов `[ТЗ 3.6.1]`. Обязательный набор — семь отчётов `SPEC.md § 9.1`. */
export function ReportsPage(): JSX.Element {
  const { t } = useTranslation();

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.reports')}</Typography.Title>

      <Row gutter={[12, 12]}>
        {REPORT_DEFINITIONS.map((report) => (
          <Col xs={24} md={12} lg={8} key={report.code}>
            <Card
              size="small"
              title={report.name.ru}
              extra={<Link to={`/reports/${report.code}`}>{t('reports.build')}</Link>}
            >
              <Space direction="vertical" size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {report.name.en}
                </Typography.Text>
                <Space size={4} wrap>
                  {report.parameters.map((param) => (
                    <Tag key={param.key} style={{ margin: 0 }}>
                      <Mono>{param.key}</Mono>
                      {param.required ? '*' : ''}
                    </Tag>
                  ))}
                </Space>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Card size="small" title={t('reports.subscriptions')}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('reports.subscriptionsHint')}
          </Typography.Text>
          <List
            size="small"
            bordered
            dataSource={[
              { code: 'flights_period', schedule: 'daily', format: 'xlsx', to: 'ops@slg.example.com' },
              { code: 'financial', schedule: 'weekly', format: 'pdf', to: 'cfo@slg.example.com' },
            ]}
            renderItem={(item) => (
              <List.Item actions={[<Button key="e" size="small">{t('common.edit')}</Button>]}>
                <Space size={10} wrap>
                  <span>{REPORT_DEFINITIONS.find((r) => r.code === item.code)?.name.ru}</span>
                  <Tag>{t(`reports.schedule.${item.schedule}`)}</Tag>
                  <Tag>{item.format.toUpperCase()}</Tag>
                  <Mono>{item.to}</Mono>
                </Space>
              </List.Item>
            )}
          />
          <Button type="primary" size="small">{t('reports.addSubscription')}</Button>
        </Space>
      </Card>
    </Space>
  );
}

/** Построитель конкретного отчёта `[ТЗ 3.6.1]` с экспортом `[ТЗ 3.6.3]`. */
export function ReportViewPage(): JSX.Element {
  const { t } = useTranslation();
  const { code } = useParams<{ code: string }>();
  const definition = REPORT_DEFINITIONS.find((r) => r.code === code);

  const data = useMemo(() => {
    switch (code) {
      case 'flights_period':
        return {
          columns: [
            { title: t('flight.number'), dataIndex: 'number', render: (v: string) => <Mono>{v}</Mono> },
            { title: t('flight.client'), dataIndex: 'clientName' },
            { title: t('flight.route'), key: 'route', render: (_: unknown, r: (typeof FLIGHT_LIST)[number]) => <Mono>{r.depIcao} → {r.arrIcao}</Mono> },
            { title: t('flight.std'), dataIndex: 'stdUtc', render: (v: string) => <UtcTime value={v} withDate /> },
            { title: t('flight.status'), dataIndex: 'status', render: (v: string) => t(`flightStatus.${v}`) },
          ],
          rows: FLIGHT_LIST.slice(0, 40),
          rowKey: 'id',
        };

      case 'services_rendered':
        return {
          columns: [
            { title: t('service.category'), key: 'cat', render: (_: unknown, r: (typeof SERVICE_ORDERS)[number]) => t(`serviceCategory.${r.service?.category ?? 'handling'}`) },
            { title: t('service.name'), key: 'name', render: (_: unknown, r: (typeof SERVICE_ORDERS)[number]) => r.service?.name.ru },
            { title: t('service.vendor'), dataIndex: 'vendorName' },
            { title: t('flight.airport'), dataIndex: 'airportIcao', render: (v: string) => <Mono>{v}</Mono> },
            { title: t('service.status'), dataIndex: 'status', render: (v: string) => t(`serviceStatus.${v}`) },
          ],
          rows: SERVICE_ORDERS.slice(0, 40),
          rowKey: 'id',
        };

      case 'financial': {
        const rows = FLIGHT_LIST.slice(0, 30).map((flight) => {
          const margin = MARGINS.get(flight.id);
          return {
            id: flight.id,
            number: flight.number,
            clientName: flight.clientName,
            revenue: margin?.revenue,
            cost: margin?.cost,
            margin: margin?.margin,
            percent: margin?.marginPercent ?? null,
          };
        });
        return {
          columns: [
            { title: t('flight.number'), dataIndex: 'number', render: (v: string) => <Mono>{v}</Mono> },
            { title: t('flight.client'), dataIndex: 'clientName' },
            { title: t('finance.revenue'), key: 'rev', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <MoneyText value={r.revenue} /> },
            { title: t('finance.cost'), key: 'cost', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <MoneyText value={r.cost} /> },
            { title: t('finance.margin'), key: 'm', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <MoneyText value={r.margin} colorBySign /> },
            { title: '%', key: 'p', align: 'right' as const, width: 90, render: (_: unknown, r: (typeof rows)[number]) => <PercentText value={r.percent} colorBySign threshold={12} /> },
          ],
          rows,
          rowKey: 'id',
        };
      }

      case 'vendors': {
        const rows = VENDORS.map((vendor) => ({
          id: vendor.id,
          name: vendor.name,
          orders: vendor.rating?.orderCount ?? 0,
          rating: vendor.rating?.sufficientData ? vendor.rating.rating : null,
          onTime: vendor.rating?.components?.onTimeConfirmRate ?? null,
        }));
        return {
          columns: [
            { title: t('service.vendor'), dataIndex: 'name' },
            { title: t('dashboard.orders'), dataIndex: 'orders', align: 'right' as const },
            { title: t('vendor.onTimeConfirm'), key: 'ot', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => (r.onTime ? <Mono>{(Number.parseFloat(r.onTime) * 100).toFixed(0)} %</Mono> : '—') },
            { title: t('vendor.rating'), key: 'r', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => (r.rating ? <Mono>{Number.parseFloat(r.rating).toFixed(2)}</Mono> : <Tag>{t('vendor.insufficientData')}</Tag>) },
          ],
          rows,
          rowKey: 'id',
        };
      }

      case 'receivables_payables': {
        const rows = RECEIVABLES_BUCKETS.map((item, index) => ({
          id: item.bucket,
          bucket: item.bucket,
          receivable: item.amount,
          payable: PAYABLES_BUCKETS[index]?.amount,
        }));
        return {
          columns: [
            { title: t('dashboard.bucket'), dataIndex: 'bucket', render: (v: string) => <Mono>{v}</Mono> },
            { title: t('dashboard.receivables'), key: 'r', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <MoneyText value={r.receivable as never} /> },
            { title: t('dashboard.payables'), key: 'p', align: 'right' as const, render: (_: unknown, r: (typeof rows)[number]) => <MoneyText value={r.payable as never} /> },
          ],
          rows,
          rowKey: 'id',
        };
      }

      case 'sla_breaches': {
        const rows = SERVICE_ORDERS.filter((o) => o.slaBreached);
        return {
          columns: [
            { title: t('flight.number'), dataIndex: 'flightId', render: (v: string) => <Mono>{FLIGHT_LIST.find((f) => f.id === v)?.number ?? v}</Mono> },
            { title: t('service.name'), key: 'n', render: (_: unknown, r: (typeof rows)[number]) => r.service?.name.ru },
            { title: t('service.vendor'), dataIndex: 'vendorName' },
            { title: t('service.slaDeadline'), dataIndex: 'slaConfirmDeadline', render: (v: string | null) => <UtcTime value={v} withDate /> },
          ],
          rows,
          rowKey: 'id',
        };
      }

      default:
        return null;
    }
  }, [code, t]);

  if (!definition) return <NotFoundPage />;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]}>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>{definition.name.ru}</Typography.Title>
        </Col>
        <Col>
          <Space size={8}>
            <Button icon={<FilePdfOutlined />}>PDF</Button>
            <Button icon={<FileExcelOutlined />}>XLSX</Button>
            <Button>CSV</Button>
            <Button>XML</Button>
          </Space>
        </Col>
      </Row>

      <Card size="small">
        <Form layout="inline">
          <Form.Item label={t('reports.period')}>
            <DatePicker.RangePicker />
          </Form.Item>
          <Form.Item label={t('flight.client')}>
            <Select
              allowClear style={{ width: 200 }}
              options={CLIENTS.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item label={t('reports.currency')}>
            <Select
              defaultValue="RUB" style={{ width: 100 }}
              options={['RUB', 'USD', 'EUR'].map((c) => ({ value: c, label: c }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary">{t('reports.build')}</Button>
          </Form.Item>
        </Form>
      </Card>

      <Alert type="info" showIcon message={t('reports.demoMarkNotice')} />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        {data ? (
          <DataTable
            size="small"
            rowKey={data.rowKey}
            columns={data.columns as never}
            dataSource={data.rows as never}
            pagination={{ pageSize: 20, size: 'small' }}
            scroll={{ x: 800 }}
          />
        ) : (
          <div style={{ padding: 16 }}>
            <EmptyState description={t('reports.notImplemented')} />
          </div>
        )}
      </Card>
    </Space>
  );
}
