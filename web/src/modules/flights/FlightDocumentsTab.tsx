import type { JSX } from 'react';
import { Button, Card, Col, Empty, List, Row, Space, Tag, Typography, Upload } from 'antd';
import { FilePdfOutlined, InboxOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Flight, ServiceOrder } from '@/api/types';
import { INVOICES, QUOTES } from '@/mocks/billing';
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
  orders: ServiceOrder[];
}): JSX.Element {
  const { t } = useTranslation();

  const quotes = QUOTES.filter((q) => q.flightId === flight.id);
  const invoices = INVOICES.filter((i) => i.flightId === flight.id);
  const attachments = orders.flatMap((order) =>
    (order.documents ?? []).map((doc) => ({ doc, order })),
  );

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
                      <Button key="pdf" size="small" icon={<FilePdfOutlined />}>
                        PDF
                      </Button>,
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
                      <Button key="pdf" size="small" icon={<FilePdfOutlined />}>
                        PDF
                      </Button>,
                    ]}
                  >
                    <Space direction="vertical" size={0}>
                      <Space size={8}>
                        <Link to={`/billing/invoices/${invoice.id}`}>
                          <Mono>{invoice.number}</Mono>
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
            <Upload.Dragger multiple disabled style={{ padding: 8 }}>
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">{t('flight.dropFiles')}</p>
              <p className="ant-upload-hint">{t('flight.dropFilesHint')}</p>
            </Upload.Dragger>

            {attachments.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('flight.noAttachments')} />
            ) : (
              <List
                size="small"
                dataSource={attachments}
                renderItem={({ doc, order }) => (
                  <List.Item
                    actions={[
                      <Button key="dl" size="small">
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
