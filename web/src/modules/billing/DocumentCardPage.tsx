import { useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Descriptions, Input, Row, Skeleton,
  Space, Table, Tag, Typography,
} from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { FileExcelOutlined, FilePdfOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useClient } from '@/api/counterparties';
import {
  useExportInvoice,
  useInvoice,
  useInvoiceAction,
  useQuote,
  useQuoteAction,
  type DocumentLineRow,
} from '@/api/documents';
import { useFlight } from '@/api/flights';
import { Can } from '@/shared/auth/Can';
import { useDemoMode } from '@/shared/auth/session';
import { DateText, MoneyText, Mono } from '@/shared/ui/primitives';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

/**
 * Котировка и счёт `[ТЗ 3.4.1]`.
 *
 * После выставления документ **неизменяем**: правки только через аннулирование
 * и выпуск нового с ссылкой на предыдущий (`BACKEND.md § 3.4`). Курс валюты
 * зафиксирован в самом документе (ADR-004).
 *
 * ADR-002: итог считается суммой уже округлённых строк — сумма в колонке
 * и «итого» обязаны сходиться до копейки, иначе клиент документу не поверит.
 */
export function DocumentCardPage({ kind }: { kind: 'quote' | 'invoice' }): JSX.Element {
  const { t } = useTranslation();
  const demoMode = useDemoMode();
  const { message, modal } = App.useApp();
  const { id } = useParams<{ id: string }>();
  // Причина аннулирования живёт снаружи диалога: содержимое диалога
  // Ant Design не перерисовывается, и читать её из состояния поля нельзя.
  const [voidReason, setVoidReason] = useState('');

  const quoteQuery = useQuote(kind === 'quote' ? id : undefined);
  const invoiceQuery = useInvoice(kind === 'invoice' ? id : undefined);
  const query = kind === 'quote' ? quoteQuery : invoiceQuery;

  const quote = quoteQuery.data;
  const invoice = invoiceQuery.data;
  const document = quote ?? invoice;

  const exportInvoice = useExportInvoice();
  const issueQuote = useQuoteAction('issue');
  const voidQuote = useQuoteAction('void');
  const issueInvoice = useInvoiceAction('issue');
  const voidInvoice = useInvoiceAction('void');

  const client = useClient(document?.clientId).data;
  const flight = useFlight(document?.flightId).data;

  if (query.isPending) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (!document) return <NotFoundPage />;

  const issued = document.status !== 'draft';
  const comparison = invoice?.planFactComparison ?? [];
  const busy =
    issueQuote.isPending ||
    voidQuote.isPending ||
    issueInvoice.isPending ||
    voidInvoice.isPending;

  /** Ошибка сервера человеку: код без текста ничего не объясняет. */
  const report = (error: unknown): void => {
    void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
  };

  /**
   * Выгрузка документа. Сервер кладёт файл в хранилище и отдаёт
   * подписанную ссылку — её и открывает браузер, в новой вкладке.
   */
  const download = (format: 'pdf' | 'xlsx'): void => {
    if (!id) return;
    exportInvoice
      .mutateAsync({ id, format })
      .then((ticket) => {
        if (ticket.downloadUrl) {
          window.open(ticket.downloadUrl, '_blank', 'noopener');
          return;
        }
        void message.info(t('finance.exportQueued'));
      })
      .catch(report);
  };

  const issue = (): void => {
    if (!id) return;
    const action = kind === 'quote' ? issueQuote : issueInvoice;
    action
      .mutateAsync({ id })
      .then((updated) => {
        void message.success(t('finance.issued', { number: updated.number ?? '' }));
      })
      .catch(report);
  };

  /**
   * Аннулирование требует причины: она уходит в аудит и объясняет,
   * почему документ с присвоенным номером больше не действует.
   */
  const requestVoid = (): void => {
    if (!id) return;
    setVoidReason('');
    modal.confirm({
      title: t('finance.voidTitle'),
      content: (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>{t('finance.voidHint')}</Typography.Text>
          <Input.TextArea
            rows={3}
            placeholder={t('finance.voidReasonPlaceholder')}
            onChange={(event) => {
              setVoidReason(event.target.value);
            }}
          />
        </Space>
      ),
      okText: t('finance.void'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const action = kind === 'quote' ? voidQuote : voidInvoice;
        try {
          await action.mutateAsync({ id, reason: voidReason });
          void message.success(t('finance.voided'));
        } catch (error) {
          report(error);
          throw error;
        }
      },
    });
  };

  const columns: DataColumns<DocumentLineRow> = [
    { title: t('finance.description'), dataIndex: 'description', ellipsis: true },
    {
      title: t('flight.airport'), dataIndex: 'airportIcao', width: 80,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('service.quantity'), dataIndex: 'quantity', width: 100, align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('finance.unitPrice'), key: 'unit', width: 140, align: 'right',
      render: (_, row) => <MoneyText value={row.unitPrice} showCurrency={false} />,
    },
    {
      title: t('finance.amount'), key: 'amount', width: 150, align: 'right',
      render: (_, row) => <MoneyText value={row.amount} showCurrency={false} />,
    },
    {
      title: t('finance.vat'), key: 'vat', width: 130, align: 'right',
      render: (_, row) => <MoneyText value={row.vatAmount} showCurrency={false} />,
    },
  ];

  const totals = document.totals;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Row gutter={[12, 12]} align="middle" wrap>
          <Col flex="auto">
            <Space direction="vertical" size={2}>
              <Space size={10} wrap align="center">
                <Typography.Title level={4} style={{ margin: 0 }}>
                  <Mono>{document.number ?? t('finance.draft')}</Mono>
                </Typography.Title>
                <Tag>
                  {kind === 'quote'
                    ? t(`quoteStatus.${document.status}`)
                    : t(`invoiceStatus.${document.status}`)}
                </Tag>
                {demoMode && document.isDemo ? <Tag color="orange">DEMO</Tag> : null}
              </Space>
              <Space size={10} wrap>
                <Typography.Text type="secondary">{client?.name}</Typography.Text>
                <Link to={`/flights/${document.flightId}`}>
                  <Mono>{flight?.number}</Mono>
                </Link>
                <Mono>{flight?.depIcao} → {flight?.arrIcao}</Mono>
              </Space>
            </Space>
          </Col>
          <Col>
            <Space size={8} wrap>
              {kind === 'invoice' ? (
                <>
                  <Button
                    icon={<FilePdfOutlined />}
                    loading={exportInvoice.isPending}
                    onClick={() => { download('pdf'); }}
                  >
                    PDF
                  </Button>
                  <Button
                    icon={<FileExcelOutlined />}
                    loading={exportInvoice.isPending}
                    onClick={() => { download('xlsx'); }}
                  >
                    XLSX
                  </Button>
                </>
              ) : null}
              <Can permission="billing.documents.edit">
                {issued ? (
                  <Button danger loading={busy} onClick={requestVoid}>
                    {t('finance.void')}
                  </Button>
                ) : (
                  <Button type="primary" loading={busy} onClick={issue}>
                    {t('finance.issue')}
                  </Button>
                )}
              </Can>
            </Space>
          </Col>
        </Row>
      </Card>

      {issued ? (
        <Alert type="info" showIcon message={t('finance.immutableNotice')} />
      ) : null}

      {demoMode && document.isDemo ? (
        <Alert type="warning" showIcon message={t('finance.demoWatermarkNotice')} />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={16}>
          <Card size="small" styles={{ body: { padding: 0 } }}>
            <DataTable<DocumentLineRow>
              size="small"
              rowKey={(row) => row.serviceOrderId ?? row.description}
              columns={columns}
              dataSource={document.lines}
              pagination={false}
              scroll={{ x: 700 }}
              summary={() => (
                <Table.Summary>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={4}>
                      <Typography.Text strong>{t('finance.subtotal')}</Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">
                      <MoneyText value={totals.subtotal} showCurrency={false} />
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">
                      <MoneyText value={totals.vatTotal} showCurrency={false} />
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                </Table.Summary>
              )}
            />
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Card size="small" title={t('finance.totals')}>
              <Descriptions size="small" column={1}>
                <Descriptions.Item label={t('finance.subtotal')}>
                  <MoneyText value={totals.subtotal} />
                </Descriptions.Item>
                <Descriptions.Item label={t('finance.fees')}>
                  <MoneyText value={totals.feesTotal} />
                </Descriptions.Item>
                <Descriptions.Item label={t('finance.discount')}>
                  <MoneyText value={totals.discountTotal} />
                </Descriptions.Item>
                <Descriptions.Item label={t('finance.vatTotal')}>
                  <MoneyText value={totals.vatTotal} />
                </Descriptions.Item>
                <Descriptions.Item label={t('finance.grandTotal')}>
                  <MoneyText value={totals.grandTotal} strong />
                </Descriptions.Item>
              </Descriptions>
            </Card>

            <Card size="small" title={t('finance.terms')}>
              <Descriptions size="small" column={1}>
                <Descriptions.Item label={t('finance.issuedAt')}>
                  <DateText value={document.issuedAt ?? null} />
                </Descriptions.Item>
                {kind === 'invoice' ? (
                  <Descriptions.Item label={t('finance.dueDate')}>
                    <DateText value={invoice?.dueDate ?? null} />
                  </Descriptions.Item>
                ) : (
                  <Descriptions.Item label={t('finance.validUntil')}>
                    <DateText value={quote?.validUntil ?? null} />
                  </Descriptions.Item>
                )}
                <Descriptions.Item label={t('client.paymentTerms')}>
                  {client ? t(`paymentMode.${client.paymentTerms.mode}`) : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('finance.fxSnapshot')}>
                  <Space direction="vertical" size={0}>
                    <Mono>1 USD = {document.fx.rates['USD'] ?? '—'} RUB</Mono>
                    <Mono>1 EUR = {document.fx.rates['EUR'] ?? '—'} RUB</Mono>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('finance.fxFixedInDocument')}
                    </Typography.Text>
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            </Card>
          </Space>
        </Col>
      </Row>

      {/* Сопоставление «план ↔ факт»: видно, за счёт чего счёт отличается */}
      {comparison.length > 0 ? (
        <Card size="small" title={t('finance.planFact')}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('finance.planFactHint')}
            </Typography.Text>
            {comparison.map((item, index) => (
              <Space key={index} size={10} wrap>
                <Tag>{t(`planFactKind.${item.kind}`)}</Tag>
                <MoneyText value={item.planValue} />
                <span>→</span>
                <MoneyText value={item.factValue} strong />
                <Typography.Text type="secondary">{item.comment}</Typography.Text>
              </Space>
            ))}
          </Space>
        </Card>
      ) : null}
    </Space>
  );
}
