import { useMemo, useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Descriptions, Input, Modal, Select, Space, Tag, Typography, Upload,
} from 'antd';
import { DownloadOutlined, InboxOutlined, UploadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  downloadInvoiceTemplate,
  useCreateVendorServiceMapping,
  useImportVendorInvoice,
  useResolveDiscrepancy,
  useVendorInvoice,
  useVendorInvoices,
  useVendorServiceMappings,
  type DiscrepancyRow,
  type VendorInvoiceRow,
} from '@/api/billing';
import { useServices } from '@/api/catalog';
import { ApiError } from '@/api/client';
import { useVendors } from '@/api/counterparties';
import { moneyDifference } from '@/domain/money';
import { Can } from '@/shared/auth/Can';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Notice } from '@/shared/ui/Notice';
import { PageHeader } from '@/shared/ui/PageHeader';
import { QueryState } from '@/shared/ui/QueryState';
import { DateText, EmptyState, MoneyText, Mono, GenericStatusTag } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const DISCREPANCY_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  price_mismatch: 'warning',
  quantity_mismatch: 'warning',
  missing_on_our_side: 'critical',
  missing_on_their_side: 'critical',
};

const RESOLUTIONS = ['accept_theirs', 'keep_ours', 'claim', 'investigate'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

/**
 * Сверка счетов поставщиков `[ТЗ 3.4.2]`.
 *
 * Счёт поставщика приходит файлом по шаблону системы. Сопоставление делает
 * сервер по ключу `поставщик + аэропорт + дата (±1 день) + код услуги`
 * с допуском 0.01 на округление (`DOMAIN.md § 7.7`). По каждому расхождению —
 * действие: принять счёт поставщика, оставить свою сумму, претензия,
 * выяснение. **Все действия идут в аудит.**
 *
 * ADR-024: коды поставщика сопоставляются с каталогом через справочник;
 * неопознанные попадают в очередь сопоставления, а не молча теряются.
 */
export function ReconciliationPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [importOpen, setImportOpen] = useState(false);

  const query = useVendorInvoices();
  const vendorsQuery = useVendors();
  const vendors = useMemo(() => vendorsQuery.data?.data ?? [], [vendorsQuery.data]);
  const vendorName = useMemo(
    () => new Map(vendors.map((vendor) => [vendor.id, vendor.name])),
    [vendors],
  );

  // Счёт из ссылки может не попасть в первую страницу реестра — тогда
  // он запрашивается отдельно.
  const listed = query.data?.data.find((item) => item.id === id);
  const single = useVendorInvoice(listed ? undefined : id);
  const selected = listed ?? single.data;

  const download = async (fileFormat: 'xlsx' | 'csv'): Promise<void> => {
    try {
      await downloadInvoiceTemplate(fileFormat);
    } catch {
      void message.error(t('reconciliation.downloadFailed'));
    }
  };

  const columns: DataColumns<VendorInvoiceRow> = [
    {
      title: t('reconciliation.invoiceNumber'), dataIndex: 'number', width: 150, filterable: 'text',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('reconciliation.vendor'), key: 'vendor', ellipsis: true,
      sortBy: (row) => vendorName.get(row.vendorId) ?? row.vendorId,
      render: (_, row) => vendorName.get(row.vendorId) ?? row.vendorId,
    },
    {
      title: t('reconciliation.issuedAt'), dataIndex: 'issuedAt', width: 120,
      render: (value: string) => <DateText value={value} />,
    },
    {
      title: t('reconciliation.lines'), key: 'lines', width: 90, align: 'right',
      sortBy: (row) => row.lines.length,
      render: (_, row) => <Mono>{row.lines.length}</Mono>,
    },
    {
      title: t('reconciliation.discrepancies'), key: 'discrepancies', width: 130, align: 'right',
      sortBy: (row) => unresolved(row),
      render: (_, row) => {
        const total = row.reconciliation.discrepancies.length;
        const open = unresolved(row);
        return (
          <Tag color={open > 0 ? 'orange' : 'green'} style={{ margin: 0 }}>
            {open > 0 ? `${String(open)} / ${String(total)}` : String(total)}
          </Tag>
        );
      },
    },
    {
      title: t('reconciliation.delta'), key: 'delta', width: 160, align: 'right',
      sortBy: (row) => Number.parseFloat(row.reconciliation.delta.amount),
      render: (_, row) => <MoneyText value={row.reconciliation.delta} colorBySign />,
    },
    {
      title: t('reconciliation.status'), key: 'status', width: 120,
      sortBy: (row) => Boolean(row.reconciliation.resolvedAt),
      render: (_, row) =>
        row.reconciliation.resolvedAt ? (
          <GenericStatusTag token="done" label={t('reconciliation.statusClosed')} />
        ) : (
          <GenericStatusTag token="progress" label={t('reconciliation.statusOpen')} />
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <PageHeader
        title={t('nav.reconciliation')}
        meta={<span>{t('reconciliation.subtitle')}</span>}
        actions={
          <Can permission="billing.reconciliation">
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                void download('xlsx');
              }}
            >
              {t('reconciliation.downloadTemplate')}
            </Button>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              onClick={() => {
                setImportOpen(true);
              }}
            >
              {t('reconciliation.import')}
            </Button>
          </Can>
        }
      />

      <Notice
        id="reconciliation.howto"
        type="info"
        showIcon
        message={t('reconciliation.howtoTitle')}
        description={
          <Space direction="vertical" size={2}>
            <span>{t('reconciliation.howto1')}</span>
            <span>{t('reconciliation.howto2')}</span>
            <span>{t('reconciliation.howto3')}</span>
          </Space>
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(page) => (
            <DataTable<VendorInvoiceRow>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={page.data}
              pagination={{ pageSize: 10, size: 'small' }}
              scroll={{ x: 900 }}
              rowClassName={(row) => (row.id === id ? 'ant-table-row-selected' : '')}
              onRow={(row) => ({
                onClick: () => {
                  navigate(`/billing/reconciliation/${row.id}`);
                },
                style: { cursor: 'pointer' },
              })}
              locale={{ emptyText: <EmptyState description={t('reconciliation.empty')} /> }}
            />
          )}
        </QueryState>
      </Card>

      {selected ? (
        <InvoiceDetails
          invoice={selected}
          vendorName={vendorName.get(selected.vendorId) ?? selected.vendorId}
        />
      ) : (query.data?.data.length ?? 0) > 0 ? (
        <Card size="small">
          <EmptyState description={t('reconciliation.selectInvoice')} />
        </Card>
      ) : null}

      <ImportModal
        open={importOpen}
        vendors={vendors}
        onDownload={(fileFormat) => {
          void download(fileFormat);
        }}
        onClose={() => {
          setImportOpen(false);
        }}
        onImported={(invoice) => {
          setImportOpen(false);
          navigate(`/billing/reconciliation/${invoice.id}`);
        }}
      />
    </Space>
  );
}

/** Файл, который сервер умеет читать (`billing.services.invoice_file`). */
function isInvoiceFile(name: string): boolean {
  return /\.(xlsx|csv)$/i.test(name);
}

/** Нерешённых расхождений в сверке. */
function unresolved(invoice: VendorInvoiceRow): number {
  return invoice.reconciliation.discrepancies.filter((item) => !item.resolution).length;
}

function InvoiceDetails({
  invoice,
  vendorName,
}: {
  invoice: VendorInvoiceRow;
  vendorName: string;
}): JSX.Element {
  const { t } = useTranslation();
  const [resolving, setResolving] = useState<number | null>(null);
  const [mapping, setMapping] = useState(false);
  const { reconciliation } = invoice;
  const discrepancies = reconciliation.discrepancies;

  // Коды, сопоставленные после импорта, из очереди уходят: сверка — снимок,
  // а справочник живой.
  const mappings = useVendorServiceMappings(invoice.vendorId).data?.data ?? [];
  const mappedCodes = new Set(mappings.map((item) => item.vendorCode.toUpperCase()));
  const unmapped = invoice.unmappedCodes.filter((code) => !mappedCodes.has(code.toUpperCase()));

  // Номер строки в расхождении — позиция в счёте, с единицы.
  const lineAt = (index: number | null) =>
    index === null ? undefined : invoice.lines[index - 1];

  const columns: DataColumns<DiscrepancyRow> = [
    {
      title: t('reconciliation.kind'), dataIndex: 'kind', width: 190,
      render: (value: string) => (
        <GenericStatusTag
          token={DISCREPANCY_TOKEN[value] ?? 'warning'}
          label={t(`discrepancyKind.${value}`)}
        />
      ),
    },
    {
      title: t('reconciliation.line'), key: 'line', width: 220, sortable: false,
      render: (_, row) => {
        const line = lineAt(row.lineIndex);
        return line ? (
          <Space direction="vertical" size={0}>
            <span>
              <Typography.Text type="secondary">
                {t('reconciliation.lineNumber', { number: row.lineIndex })}
              </Typography.Text>{' '}
              <Mono>{line.serviceCode}</Mono>
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Mono>{line.airportIcao}</Mono> · <DateText value={line.serviceDate} />
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">{t('reconciliation.noLine')}</Typography.Text>
        );
      },
    },
    {
      title: t('reconciliation.ours'), key: 'ours', width: 150, align: 'right', sortable: false,
      render: (_, row) => <MoneyText value={row.ours} />,
    },
    {
      title: t('reconciliation.theirs'), key: 'theirs', width: 150, align: 'right', sortable: false,
      render: (_, row) => <MoneyText value={row.theirs} />,
    },
    {
      title: t('reconciliation.delta'), key: 'delta', width: 150, align: 'right', sortable: false,
      render: (_, row) =>
        row.ours && row.theirs ? (
          <MoneyText value={moneyDifference(row.theirs, row.ours)} colorBySign />
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: t('reconciliation.resolution'), key: 'resolution', width: 200, sortable: false,
      render: (_, row) =>
        row.resolution ? (
          <Space direction="vertical" size={0}>
            <Tag color="green" style={{ margin: 0 }}>{t(`resolution.${row.resolution}`)}</Tag>
            {row.comment ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.comment}</Typography.Text>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">{t('reconciliation.unresolved')}</Typography.Text>
        ),
    },
    {
      title: t('common.actions'), key: 'actions', sortable: false, width: 120,
      render: (_, row) =>
        row.resolution ? null : (
          <Can permission="billing.reconciliation">
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setResolving(discrepancies.indexOf(row));
              }}
            >
              {t('reconciliation.resolve')}
            </Button>
          </Can>
        ),
    },
  ];

  return (
    <>
      <Card size="small">
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} bordered>
          <Descriptions.Item label={t('reconciliation.vendor')}>{vendorName}</Descriptions.Item>
          <Descriptions.Item label={t('reconciliation.invoiceNumber')}>
            <Mono>{invoice.number}</Mono>
          </Descriptions.Item>
          <Descriptions.Item label={t('reconciliation.totalOurs')}>
            <MoneyText value={reconciliation.totalOurs} />
          </Descriptions.Item>
          <Descriptions.Item label={t('reconciliation.totalTheirs')}>
            <MoneyText value={reconciliation.totalTheirs} />
          </Descriptions.Item>
          <Descriptions.Item label={t('reconciliation.matched')}>
            {reconciliation.matched.length}{' '}
            {t('reconciliation.ofLines', { count: invoice.lines.length })}
          </Descriptions.Item>
          <Descriptions.Item label={t('reconciliation.discrepancies')}>
            <Tag color={discrepancies.length > 0 ? 'orange' : 'green'}>{discrepancies.length}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t('reconciliation.delta')} span={2}>
            <MoneyText value={reconciliation.delta} strong colorBySign />
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {unmapped.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('reconciliation.unmappedTitle', { count: unmapped.length })}
          description={
            <Space direction="vertical" size={4}>
              <Space size={4} wrap>
                {unmapped.map((code) => (
                  <Mono key={code}>{code}</Mono>
                ))}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('reconciliation.unmappedHint')}
              </Typography.Text>
            </Space>
          }
          action={
            <Can permission="billing.reconciliation">
              <Button
                size="small"
                onClick={() => {
                  setMapping(true);
                }}
              >
                {t('reconciliation.mapCodes')}
              </Button>
            </Can>
          }
        />
      ) : null}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<DiscrepancyRow>
          size="small"
          rowKey={(row) => `${row.kind}_${String(row.lineIndex ?? 'x')}_${row.serviceOrderId ?? 'x'}`}
          columns={columns}
          dataSource={discrepancies}
          pagination={false}
          scroll={{ x: 1100 }}
          locale={{ emptyText: <EmptyState description={t('reconciliation.noDiscrepancies')} /> }}
        />
      </Card>

      <ResolveModal
        invoice={invoice}
        index={resolving}
        onClose={() => {
          setResolving(null);
        }}
      />

      {mapping ? (
        <MapCodesModal
          vendorId={invoice.vendorId}
          codes={unmapped}
          onClose={() => {
            setMapping(false);
          }}
        />
      ) : null}
    </>
  );
}

function ImportModal({
  open,
  vendors,
  onDownload,
  onClose,
  onImported,
}: {
  open: boolean;
  vendors: { id: string; name: string }[];
  onDownload: (fileFormat: 'xlsx' | 'csv') => void;
  onClose: () => void;
  onImported: (invoice: VendorInvoiceRow) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const importInvoice = useImportVendorInvoice();
  const [vendorId, setVendorId] = useState<string | undefined>();
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<{ message: string; rows: string[] } | null>(null);
  // Подсказки «чего не хватает» — после первой попытки, а не сразу при открытии.
  const [attempted, setAttempted] = useState(false);
  const [wrongFormat, setWrongFormat] = useState<string | null>(null);

  const reset = (): void => {
    setVendorId(undefined);
    setFile(null);
    setFailure(null);
    setAttempted(false);
    setWrongFormat(null);
  };

  const pick = (picked: File): void => {
    if (!isInvoiceFile(picked.name)) {
      setWrongFormat(picked.name);
      return;
    }
    setFile(picked);
    setWrongFormat(null);
    setFailure(null);
  };

  // Кнопка не выключается: выключенная кнопка не говорит, чего ей не хватает.
  const submit = async (): Promise<void> => {
    setAttempted(true);
    if (!vendorId || !file) return;
    setFailure(null);
    try {
      const invoice = await importInvoice.mutateAsync({ vendorId, file });
      void message.success(t('reconciliation.imported', { number: invoice.number }));
      reset();
      onImported(invoice);
    } catch (error) {
      const rows = error instanceof ApiError ? error.details['rows'] : undefined;
      setFailure({
        message: error instanceof ApiError ? error.message : t('common.saveFailed'),
        rows: Array.isArray(rows) ? rows.map(String) : [],
      });
    }
  };

  return (
    <Modal
      open={open}
      title={t('reconciliation.import')}
      okText={t('reconciliation.startImport')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: importInvoice.isPending }}
      onCancel={() => {
        reset();
        onClose();
      }}
      onOk={() => {
        void submit();
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
            placeholder={t('reconciliation.vendorRequired')}
            status={attempted && !vendorId ? 'error' : ''}
            value={vendorId}
            onChange={setVendorId}
            options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
          />
          {attempted && !vendorId ? (
            <Typography.Text type="danger">{t('reconciliation.vendorRequired')}</Typography.Text>
          ) : null}
        </div>
        <Upload.Dragger
          maxCount={1}
          fileList={
            file ? [{ uid: 'invoice', name: file.name, status: 'done' as const }] : []
          }
          // Файл не уходит сам: его отправляет кнопка вместе с поставщиком.
          // Формат проверяется здесь, а не фильтром `accept`: фильтр молча
          // отбрасывает перетащенный файл не того формата, и кажется, что
          // окно сломано.
          beforeUpload={(picked) => {
            pick(picked);
            return false;
          }}
          onRemove={() => {
            setFile(null);
          }}
          style={{ padding: 8 }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{t('reconciliation.dropFile')}</p>
          <p className="ant-upload-hint">{t('reconciliation.dropFileHint')}</p>
        </Upload.Dragger>
        {wrongFormat ? (
          <Typography.Text type="danger">
            {t('reconciliation.wrongFormat', { name: wrongFormat })}
          </Typography.Text>
        ) : attempted && !file ? (
          <Typography.Text type="danger">{t('reconciliation.fileRequired')}</Typography.Text>
        ) : null}
        <Space size={8} wrap>
          <Typography.Text type="secondary">{t('reconciliation.noTemplate')}</Typography.Text>
          <Typography.Link
            onClick={() => {
              onDownload('xlsx');
            }}
          >
            {t('reconciliation.templateXlsx')}
          </Typography.Link>
          <Typography.Link
            onClick={() => {
              onDownload('csv');
            }}
          >
            {t('reconciliation.templateCsv')}
          </Typography.Link>
        </Space>
        {failure ? (
          <Alert
            type="error"
            showIcon
            message={`${t('reconciliation.importFailed')}: ${failure.message}`}
            description={
              failure.rows.length > 0 ? (
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {failure.rows.map((row) => (
                    <li key={row}>{row}</li>
                  ))}
                </ul>
              ) : undefined
            }
          />
        ) : null}
      </Space>
    </Modal>
  );
}

function ResolveModal({
  invoice,
  index,
  onClose,
}: {
  invoice: VendorInvoiceRow;
  index: number | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const resolve = useResolveDiscrepancy();
  const [resolution, setResolution] = useState<Resolution>('accept_theirs');
  const [comment, setComment] = useState('');

  const discrepancy = index === null ? undefined : invoice.reconciliation.discrepancies[index];

  const close = (): void => {
    setResolution('accept_theirs');
    setComment('');
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (index === null) return;
    try {
      await resolve.mutateAsync({ id: invoice.id, discrepancyIndex: index, resolution, comment });
      void message.success(t('reconciliation.resolved'));
      close();
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Modal
      open={index !== null}
      title={t('reconciliation.resolveTitle')}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      okButtonProps={{ loading: resolve.isPending }}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {discrepancy ? (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={t('reconciliation.kind')}>
              {t(`discrepancyKind.${discrepancy.kind}`)}
            </Descriptions.Item>
            <Descriptions.Item label={t('reconciliation.ours')}>
              <MoneyText value={discrepancy.ours} />
            </Descriptions.Item>
            <Descriptions.Item label={t('reconciliation.theirs')}>
              <MoneyText value={discrepancy.theirs} />
            </Descriptions.Item>
          </Descriptions>
        ) : null}

        <Select
          style={{ width: '100%' }}
          value={resolution}
          onChange={setResolution}
          options={RESOLUTIONS.map((code) => ({ value: code, label: t(`resolution.${code}`) }))}
        />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t(`resolutionHint.${resolution}`)}
        </Typography.Text>

        <Input.TextArea
          rows={3}
          placeholder={t('reconciliation.commentPlaceholder')}
          value={comment}
          onChange={(event) => {
            setComment(event.target.value);
          }}
        />
      </Space>
    </Modal>
  );
}

/** Сопоставление кодов поставщика с каталогом (ADR-024). */
function MapCodesModal({
  vendorId,
  codes,
  onClose,
}: {
  vendorId: string;
  codes: string[];
  onClose: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const services = useServices().data?.data ?? [];
  const create = useCreateVendorServiceMapping();
  const [choice, setChoice] = useState<Record<string, string>>({});

  const chosen = Object.entries(choice);
  const language = i18n.language.startsWith('en') ? 'en' : 'ru';

  const submit = async (): Promise<void> => {
    try {
      for (const [vendorCode, serviceId] of chosen) {
        await create.mutateAsync({ vendorId, vendorCode, serviceId });
      }
      void message.success(t('reconciliation.mapped'));
      onClose();
    } catch (error) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    }
  };

  return (
    <Modal
      open
      title={t('reconciliation.mapTitle')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: chosen.length === 0, loading: create.isPending }}
      onCancel={onClose}
      onOk={() => {
        void submit();
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('reconciliation.mapHint')}</Typography.Text>
        {codes.map((code) => (
          <Space key={code} style={{ width: '100%' }} styles={{ item: { flex: 1 } }}>
            <Mono>{code}</Mono>
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('reconciliation.mapService')}
              value={choice[code]}
              onChange={(serviceId: string | undefined) => {
                setChoice((current) => {
                  const rest = Object.fromEntries(
                    Object.entries(current).filter(([key]) => key !== code),
                  );
                  return serviceId ? { ...rest, [code]: serviceId } : rest;
                });
              }}
              options={services.map((service) => ({
                value: service.id,
                label: `${service.code} · ${service.name[language]}`,
              }))}
            />
          </Space>
        ))}
      </Space>
    </Modal>
  );
}
