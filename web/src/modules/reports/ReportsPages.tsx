import { useMemo, useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, DatePicker, Form, List, Popconfirm, Row, Select, Space,
  Spin, Tag, Typography,
} from 'antd';
import { FileExcelOutlined, FilePdfOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { currencyCodeSchema } from '@/api/catalog';
import { useClients, useVendors } from '@/api/counterparties';
import {
  exportFormats,
  useDeleteSubscription,
  useExportReport,
  useReport,
  useReportCatalog,
  useReportSubscriptions,
  type ExportFormat,
  type ReportColumn,
  type ReportDefinition,
  type ReportParams,
  type ReportResult,
  type ReportRow,
  type ReportSubscription,
} from '@/api/reports';
import type { ServiceCategory } from '@/api/types';
import { DataTable } from '@/shared/ui/DataTable';
import { EmptyState, MoneyText, Mono, PercentText, UtcTime } from '@/shared/ui/primitives';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

import { SubscriptionFormModal } from './SubscriptionFormModal';

const CATEGORIES: ServiceCategory[] = [
  'fuel',
  'handling',
  'catering',
  'transport',
  'permits',
  'deicing',
];

/** Каталог отчётов `[ТЗ 3.6.1]` и подписки `[ТЗ 3.6.3]`. */
export function ReportsPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const catalog = useReportCatalog();
  const subscriptions = useReportSubscriptions();
  const deleteSubscription = useDeleteSubscription();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReportSubscription | null>(null);

  const definitions = catalog.data ?? [];
  const nameOf = (code: string): string =>
    definitions.find((definition) => definition.code === code)?.name.ru ?? code;

  const unsubscribe = async (id: string): Promise<void> => {
    try {
      await deleteSubscription.mutateAsync(id);
      void message.success(t('reports.subscriptionRemoved'));
    } catch {
      void message.error(t('common.saveFailed'));
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.reports')}</Typography.Title>

      {catalog.isError ? (
        <Alert type="error" showIcon message={t('common.error')} />
      ) : null}

      <Spin spinning={catalog.isLoading}>
        <Row gutter={[12, 12]}>
          {definitions.map((report) => (
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
      </Spin>

      <Card size="small" title={t('reports.subscriptions')}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('reports.subscriptionsHint')}
          </Typography.Text>

          <List
            size="small"
            bordered
            loading={subscriptions.isLoading}
            locale={{ emptyText: <EmptyState description={t('reports.noSubscriptions')} /> }}
            dataSource={subscriptions.data ?? []}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="edit"
                    size="small"
                    onClick={() => {
                      setEditing(item);
                      setFormOpen(true);
                    }}
                  >
                    {t('common.edit')}
                  </Button>,
                  <Popconfirm
                    key="off"
                    title={t('reports.unsubscribeConfirm')}
                    okText={t('common.yes')}
                    cancelText={t('common.no')}
                    onConfirm={() => {
                      void unsubscribe(item.id);
                    }}
                  >
                    <Button size="small" danger>{t('reports.unsubscribe')}</Button>
                  </Popconfirm>,
                ]}
              >
                <Space size={10} wrap>
                  <span>{nameOf(item.code)}</span>
                  <Tag>{t(`reports.schedule.${item.schedule}`)}</Tag>
                  <Mono>{item.timeUtc}Z</Mono>
                  <Tag>{item.format.toUpperCase()}</Tag>
                  <Mono>{item.recipients.join(', ')}</Mono>
                </Space>
              </List.Item>
            )}
          />

          <Button
            type="primary"
            size="small"
            disabled={definitions.length === 0}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            {t('reports.addSubscription')}
          </Button>
        </Space>
      </Card>

      <SubscriptionFormModal
        open={formOpen}
        editing={editing}
        definitions={definitions}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />
    </Space>
  );
}

interface FilterValues {
  period?: [Dayjs, Dayjs];
  asOf?: Dayjs;
  clientId?: string;
  vendorId?: string;
  category?: ServiceCategory;
  currency?: string;
}

/** Строка запроса отчёта из значений формы отбора. */
function toParams(definition: ReportDefinition, values: FilterValues): ReportParams {
  const keys = new Set(definition.parameters.map((parameter) => parameter.key));
  const params: ReportParams = {};

  if (keys.has('from') && values.period) {
    params['from'] = values.period[0].format('YYYY-MM-DD');
    params['to'] = values.period[1].format('YYYY-MM-DD');
  }
  if (keys.has('asOf') && values.asOf) params['asOf'] = values.asOf.format('YYYY-MM-DD');
  if (keys.has('clientId')) params['clientId'] = values.clientId;
  if (keys.has('vendorId')) params['vendorId'] = values.vendorId;
  if (keys.has('category')) params['category'] = values.category;
  params['currency'] = values.currency;

  return params;
}

/**
 * Скалярное значение ячейки текстом.
 *
 * Значения строк отчёта — скаляры JSON. Объект здесь означал бы
 * расхождение с контрактом, и показывать его как `[object Object]`
 * незачем: ячейка остаётся пустой.
 */
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Денежная ячейка отчёта.
 *
 * Валюта берётся из самой строки: отчёт бывает многовалютным — закупка
 * у поставщика в EUR, счёт клиенту в RUB. Код вне перечисления контракта
 * не подменяется знакомым: сумма показывается как есть, без валютного
 * знака, а не помечается рублём (`CLAUDE.md § 4`).
 */
function MoneyCell({ value, currency }: { value: string; currency: unknown }): JSX.Element {
  const parsed = currencyCodeSchema.safeParse(currency);
  if (!parsed.success) return <Mono>{value}</Mono>;
  return <MoneyText value={{ amount: value, currency: parsed.data }} colorBySign />;
}

/**
 * Колонки таблицы из описания, пришедшего с сервера.
 *
 * Тип колонки определяет и выравнивание, и способ отображения: деньги
 * с двумя знаками и валютой, доля — через `PercentText`, который отличает
 * «ноль процентов» от «не из чего считать» (`DOMAIN.md § 7.3`).
 */
function buildColumns(columns: ReportColumn[], locale: string): object[] {
  const title = (column: ReportColumn): string =>
    locale.startsWith('en') ? column.title.en : column.title.ru;

  return columns.map((column) => {
    const base = { title: title(column), key: column.key, dataIndex: column.key };

    switch (column.type) {
      case 'money':
        return {
          ...base,
          align: 'right' as const,
          render: (value: unknown, row: ReportRow) =>
            typeof value === 'string' ? (
              <MoneyCell value={value} currency={row['currency']} />
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            ),
        };

      case 'percent':
        return {
          ...base,
          align: 'right' as const,
          width: 110,
          render: (value: unknown) => (
            <PercentText value={typeof value === 'string' ? value : null} colorBySign />
          ),
        };

      case 'number':
        return {
          ...base,
          align: 'right' as const,
          render: (value: unknown) => {
            const text = asText(value);
            return text === null ? (
              <Typography.Text type="secondary">—</Typography.Text>
            ) : (
              <Mono>{text}</Mono>
            );
          },
        };

      case 'date':
        return {
          ...base,
          render: (value: unknown) => (
            <UtcTime value={typeof value === 'string' ? value : null} withDate />
          ),
        };

      default:
        return {
          ...base,
          render: (value: unknown) =>
            asText(value) ?? <Typography.Text type="secondary">—</Typography.Text>,
        };
    }
  });
}

/** Итоговая строка под таблицей. Считает сервер, здесь — только показ. */
function TotalsRow({ result }: { result: ReportResult }): JSX.Element | null {
  const { t } = useTranslation();
  const entries = Object.entries(result.totals);
  if (entries.length === 0) return null;

  const titleOf = (key: string): string =>
    result.columns.find((column) => column.key === key)?.title.ru ?? key;
  const typeOf = (key: string): string =>
    result.columns.find((column) => column.key === key)?.type ?? 'string';

  return (
    <Space size={16} wrap style={{ padding: '8px 12px' }}>
      <Typography.Text strong>{t('reports.totals')}</Typography.Text>
      {entries.map(([key, value]) => (
        <Space key={key} size={4}>
          <Typography.Text type="secondary">{titleOf(key)}:</Typography.Text>
          {typeOf(key) === 'money' ? (
            <MoneyCell value={asText(value) ?? '0'} currency={result.currency} />
          ) : (
            <Mono>{asText(value) ?? '—'}</Mono>
          )}
        </Space>
      ))}
    </Space>
  );
}

/** Построитель конкретного отчёта `[ТЗ 3.6.1]` с выгрузкой `[ТЗ 3.6.3]`. */
export function ReportViewPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const { code } = useParams<{ code: string }>();

  const catalog = useReportCatalog();
  const clients = useClients();
  const vendors = useVendors();
  const exportReport = useExportReport();

  const [form] = Form.useForm<FilterValues>();
  // Параметры фиксируются нажатием «Построить», а не движением в форме:
  // отчёт за период по всем рейсам — тяжёлая выборка, и перестраивать
  // её на каждый выбранный день незачем.
  const [params, setParams] = useState<ReportParams | null>(null);
  const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null);

  const definition = catalog.data?.find((item) => item.code === code);
  const parameterKeys = useMemo(
    () => new Set((definition?.parameters ?? []).map((parameter) => parameter.key)),
    [definition],
  );

  const report = useReport(code, params ?? {}, params !== null);
  const columns = useMemo(
    () => buildColumns(report.data?.columns ?? [], i18n.language),
    [report.data, i18n.language],
  );

  if (catalog.isLoading) return <Spin />;
  if (!definition) return <NotFoundPage />;

  const build = (): void => {
    setParams(toParams(definition, form.getFieldsValue()));
  };

  const download = async (format: ExportFormat): Promise<void> => {
    const current = params ?? toParams(definition, form.getFieldsValue());
    setParams(current);
    setPendingFormat(format);

    try {
      const ticket = await exportReport.mutateAsync({
        code: definition.code,
        format,
        params: current,
      });
      if (ticket.downloadUrl) {
        // Ссылка подписанная и со сроком жизни: файл отдаёт хранилище,
        // а не приложение.
        window.open(ticket.downloadUrl, '_blank', 'noopener');
      } else {
        void message.warning(t('reports.exportQueued'));
      }
    } catch {
      void message.error(t('reports.exportFailed'));
    } finally {
      setPendingFormat(null);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]}>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {definition.name.ru}
          </Typography.Title>
        </Col>
        <Col>
          <Space size={8}>
            {exportFormats.map((format) => (
              <Button
                key={format}
                icon={
                  format === 'pdf' ? <FilePdfOutlined /> :
                  format === 'xlsx' ? <FileExcelOutlined /> : undefined
                }
                loading={pendingFormat === format}
                disabled={pendingFormat !== null && pendingFormat !== format}
                onClick={() => {
                  void download(format);
                }}
              >
                {format.toUpperCase()}
              </Button>
            ))}
          </Space>
        </Col>
      </Row>

      <Card size="small">
        <Form<FilterValues> form={form} layout="inline">
          {parameterKeys.has('from') ? (
            <Form.Item name="period" label={t('reports.period')}>
              <DatePicker.RangePicker />
            </Form.Item>
          ) : null}

          {parameterKeys.has('asOf') ? (
            <Form.Item name="asOf" label={t('reports.asOf')}>
              <DatePicker />
            </Form.Item>
          ) : null}

          {parameterKeys.has('clientId') ? (
            <Form.Item name="clientId" label={t('flight.client')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 200 }}
                options={(clients.data?.data ?? []).map((client) => ({
                  value: client.id,
                  label: client.name,
                }))}
              />
            </Form.Item>
          ) : null}

          {parameterKeys.has('vendorId') ? (
            <Form.Item name="vendorId" label={t('service.vendor')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 200 }}
                options={(vendors.data?.data ?? []).map((vendor) => ({
                  value: vendor.id,
                  label: vendor.name,
                }))}
              />
            </Form.Item>
          ) : null}

          {parameterKeys.has('category') ? (
            <Form.Item name="category" label={t('service.category')}>
              <Select
                allowClear
                style={{ width: 170 }}
                options={CATEGORIES.map((value) => ({
                  value,
                  label: t(`serviceCategory.${value}`),
                }))}
              />
            </Form.Item>
          ) : null}

          <Form.Item name="currency" label={t('reports.currency')} initialValue="RUB">
            <Select
              style={{ width: 100 }}
              options={['RUB', 'USD', 'EUR'].map((value) => ({ value, label: value }))}
            />
          </Form.Item>

          <Form.Item>
            <Button type="primary" loading={report.isFetching} onClick={build}>
              {t('reports.build')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {report.data?.isDemo ? (
        <Alert type="info" showIcon message={t('reports.demoMarkNotice')} />
      ) : null}

      {report.isError ? <Alert type="error" showIcon message={t('common.error')} /> : null}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        {params === null ? (
          <div style={{ padding: 16 }}>
            <EmptyState description={t('reports.pressBuild')} />
          </div>
        ) : (
          <>
            <DataTable
              size="small"
              loading={report.isFetching}
              rowKey={(_: ReportRow, index?: number) => String(index)}
              columns={columns as never}
              dataSource={(report.data?.rows ?? []) as never}
              pagination={{ pageSize: 20, size: 'small' }}
              scroll={{ x: 800 }}
            />
            {report.data ? <TotalsRow result={report.data} /> : null}
          </>
        )}
      </Card>

      {report.data ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('reports.generatedAt')} <UtcTime value={report.data.generatedAt} withDate />
        </Typography.Text>
      ) : null}
    </Space>
  );
}
