import type { JSX } from 'react';
import { App, Button, Card, Col, Empty, List, Row, Space, Tag, Typography } from 'antd';
import { FilePdfOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import { useExportInvoice, useInvoices, useQuotes } from '@/api/documents';
import type { Flight } from '@/api/flights';
import type { ServiceOrderRow } from '@/api/orders';
import { DateText, MoneyText, Mono } from '@/shared/ui/primitives';

/**
 * Документы рейса: котировка, счёт, акты и вложения.
 *
 * ADR-007: файлы лежат в S3-совместимом хранилище и отдаются по подписанной
 * ссылке с ограниченным сроком жизни, а не по прямому пути.
 */
export function FlightDocumentsTab({
  flight,
  orders,
}: {
  flight: Flight;
  orders: ServiceOrderRow[];
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const quotes = useQuotes({ flightId: flight.id }).data?.data ?? [];
  const invoices = useInvoices({ flightId: flight.id }).data?.data ?? [];
  const attachments = orders.flatMap((order) =>
    order.documents.map((doc) => ({ doc, order })),
  );

  const exportInvoice = useExportInvoice();

  /** Выгрузка счёта: ссылку выдаёт сервер, браузер её открывает. */
  const downloadInvoice = (id: string): void => {
    exportInvoice
      .mutateAsync({ id, format: 'pdf' })
      .then((ticket) => {
        if (ticket.downloadUrl) window.open(ticket.downloadUrl, '_blank', 'noopener');
      })
      .catch((error: unknown) => {
        void message.error(
          error instanceof ApiError ? error.message : t('common.saveFailed'),
        );
      });
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={12}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Card size="small" title={t('finance.quotes')}>
            {quotes.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('finance.noQuote')} />
            ) : (
              <List
                dataSource={quotes}
                renderItem={(quote) => (
                  <List.Item
                    actions={[
                      <Link key="open" to={`/billing/quotes/${quote.id}`}>
                        <Button size="small">{t('common.open')}</Button>
                      </Link>,
                    ]}
                  >
                    <Space direction="vertical" size={0}>
                      <Space size={8}>
                        <Link to={`/billing/quotes/${quote.id}`}>
                          <Mono>{quote.number ?? t('finance.draft')}</Mono>
                        </Link>
                        <Tag>{t(`quoteStatus.${quote.status}`)}</Tag>
                      </Space>
                      <Space size={8}>
                        <MoneyText value={quote.totals.grandTotal} strong />
                        <Typography.Text type="secondary">
                          <DateText value={quote.issuedAt ?? null} />
                        </Typography.Text>
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>

          <Card size="small" title={t('finance.invoices')}>
            {invoices.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('finance.noInvoice')} />
            ) : (
              <List
                dataSource={invoices}
                renderItem={(invoice) => (
                  <List.Item
                    actions={[
                      <Button
                        key="pdf"
                        size="small"
                        icon={<FilePdfOutlined />}
                        loading={exportInvoice.isPending}
                        onClick={() => { downloadInvoice(invoice.id); }}
                      >
                        PDF
                      </Button>,
                    ]}
                  >
                    <Space direction="vertical" size={0}>
                      <Space size={8}>
                        <Link to={`/billing/invoices/${invoice.id}`}>
                          <Mono>{invoice.number ?? t('finance.draft')}</Mono>
                        </Link>
                        <Tag>{t(`invoiceStatus.${invoice.status}`)}</Tag>
                      </Space>
                      <MoneyText value={invoice.totals.grandTotal} strong />
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Space>
      </Col>

      <Col xs={24} lg={12}>
        <Card size="small" title={t('flight.attachments')}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('flight.attachmentsBelongToOrders')}
            </Typography.Text>

            {attachments.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('flight.noAttachments')} />
            ) : (
              <List
                size="small"
                dataSource={attachments}
                renderItem={({ doc, order }) => (
                  <List.Item
                    actions={[
                      // Ссылка подписана сервером и живёт ограниченное время
                      // (ADR-007): прямого пути к файлу в хранилище нет.
                      <Button
                        key="dl"
                        size="small"
                        disabled={doc.downloadUrl === null}
                        href={doc.downloadUrl ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('common.download')}
                      </Button>,
                    ]}
                  >
                    <Space direction="vertical" size={0}>
                      <Space size={6}>
                        <Mono>{doc.fileName}</Mono>
                        <Tag>{t(`attachmentKind.${doc.kind}`)}</Tag>
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {order.service?.name.ru} · {Math.round(doc.sizeBytes / 1024)} КБ ·{' '}
                        <DateText value={doc.uploadedAt} />
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Space>
        </Card>
      </Col>
    </Row>
  );
}
