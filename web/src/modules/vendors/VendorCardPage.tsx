import type { JSX } from 'react';
import { Card, Col, Descriptions, Progress, Row, Space, Tabs, Tag, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { VendorPrice } from '@/api/types';
import { CONTRACT_BY_VENDOR, VENDOR_BY_ID, VENDOR_PRICES } from '@/mocks/counterparties';
import { SERVICE_BY_ID } from '@/mocks/reference';
import { DateText, EmptyState, Field, MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';

/** Профиль поставщика `[ТЗ 3.3.1]` с разложением рейтинга на составляющие. */
export function VendorCardPage(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const vendor = id ? VENDOR_BY_ID.get(id) : undefined;

  if (!vendor) return <NotFoundPage />;

  const contract = CONTRACT_BY_VENDOR.get(vendor.id);
  const prices = VENDOR_PRICES.filter((p) => p.vendorId === vendor.id);
  const rating = vendor.rating;

  const components = [
    { key: 'onTimeConfirmRate', weight: '0.30' },
    { key: 'slaComplianceRate', weight: '0.30' },
    { key: 'billingAccuracy', weight: '0.20' },
    { key: 'qualityScore', weight: '0.20' },
  ] as const;

  const priceColumns: DataColumns<VendorPrice> = [
    {
      title: t('service.name'),
      dataIndex: 'serviceId',
      render: (value: string) => SERVICE_BY_ID.get(value)?.name.ru ?? value,
    },
    {
      title: t('flight.airport'),
      dataIndex: 'airportIcao',
      width: 90,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('catalog.unitPrice'),
      key: 'price',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.price} />,
    },
    {
      title: t('catalog.minCharge'),
      key: 'min',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.minCharge ?? null} />,
    },
    {
      title: t('catalog.surcharges'),
      key: 'surcharges',
      width: 220,
      render: (_, row) =>
        (row.surcharges ?? []).length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {(row.surcharges ?? []).map((s) => (
              <Tag key={s.code} style={{ margin: 0 }}>
                {t(`surcharge.${s.code}`)} +{Number.parseFloat(s.value).toFixed(0)}
                {s.kind === 'percent' ? '%' : ''}
                {s.appliesWhen?.fromLocalTime
                  ? ` (${s.appliesWhen.fromLocalTime}–${s.appliesWhen.toLocalTime ?? ''} LT)`
                  : ''}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: t('catalog.validity'),
      key: 'validity',
      width: 190,
      render: (_, row) => (
        <Space size={4}>
          <DateText value={row.validFrom} />
          <span>—</span>
          <DateText value={row.validTo} />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Row gutter={[12, 12]} align="middle" wrap>
          <Col flex="auto">
            <Space direction="vertical" size={2}>
              <Space size={8} wrap align="center">
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {vendor.name}
                </Typography.Title>
                {!vendor.isActive ? <Tag>{t('common.inactive')}</Tag> : null}
                {vendor.specializations.map((code) => (
                  <Tag key={code}>{t(`serviceCategory.${code}`)}</Tag>
                ))}
              </Space>
              <Typography.Text type="secondary">{vendor.legalName}</Typography.Text>
            </Space>
          </Col>
          <Col>
            <Space size={20}>
              <Field label={t('vendor.rating')}>
                {rating?.sufficientData ? (
                  <Typography.Title level={3} style={{ margin: 0 }}>
                    <Mono>{Number.parseFloat(rating.rating ?? '0').toFixed(2)}</Mono>
                    <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                      {' '}
                      / 5
                    </Typography.Text>
                  </Typography.Title>
                ) : (
                  <Typography.Text type="secondary">{t('vendor.insufficientData')}</Typography.Text>
                )}
              </Field>
              <Field label={t('vendor.currency')}>
                <Mono>{vendor.settlementCurrency}</Mono>
              </Field>
            </Space>
          </Col>
        </Row>
      </Card>

      <Tabs
        items={[
          {
            key: 'profile',
            label: t('vendor.tabs.profile'),
            children: (
              <Row gutter={[12, 12]}>
                <Col xs={24} lg={12}>
                  <Card size="small" title={t('vendor.sections.terms')}>
                    <Descriptions size="small" column={1} bordered>
                      <Descriptions.Item label={t('vendor.currency')}>
                        <Mono>{vendor.settlementCurrency}</Mono>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('client.paymentTerms')}>
                        {t(`paymentMode.${vendor.paymentTerms?.mode ?? 'deferred'}`)},{' '}
                        {vendor.paymentTerms?.deferDays ?? 0} {t('common.days')}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('vendor.exchange')}>
                        <Tag>{t(`vendor.exchangeMethod.${vendor.exchangeMethod ?? 'email'}`)}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('contract.number')}>
                        {contract ? (
                          <Space size={6}>
                            <Mono>{contract.number}</Mono>
                            <Tag
                              color={
                                contract.status === 'expired'
                                  ? 'red'
                                  : contract.status === 'expiring'
                                    ? 'orange'
                                    : 'green'
                              }
                            >
                              {t(`contractStatus.${contract.status}`)}
                            </Tag>
                            <DateText value={contract.validTo} />
                          </Space>
                        ) : (
                          <Typography.Text type="secondary">—</Typography.Text>
                        )}
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                </Col>

                <Col xs={24} lg={12}>
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Card size="small" title={t('vendor.sections.rating')}>
                      {rating?.sufficientData ? (
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          {components.map(({ key, weight }) => {
                            const value = Number.parseFloat(rating.components?.[key] ?? '0');
                            return (
                              <div key={key}>
                                <Space
                                  style={{ width: '100%', justifyContent: 'space-between' }}
                                  size={8}
                                >
                                  <Typography.Text style={{ fontSize: 12 }}>
                                    {t(`vendor.${key === 'onTimeConfirmRate' ? 'onTimeConfirm' : key === 'slaComplianceRate' ? 'slaCompliance' : key === 'billingAccuracy' ? 'billingAccuracy' : 'qualityScore'}`)}
                                  </Typography.Text>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {t('vendor.weight')} {weight}
                                  </Typography.Text>
                                </Space>
                                <Progress
                                  percent={value * 100}
                                  size="small"
                                  strokeColor={
                                    value >= 0.9
                                      ? STATUS_TOKENS.done.color
                                      : value >= 0.75
                                        ? STATUS_TOKENS.warning.color
                                        : STATUS_TOKENS.critical.color
                                  }
                                  format={(percent) => `${(percent ?? 0).toFixed(0)} %`}
                                />
                              </div>
                            );
                          })}
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {t('vendor.basedOn', { count: rating.orderCount })}. {t('vendor.formulaHint')}
                          </Typography.Text>
                        </Space>
                      ) : (
                        <EmptyState description={t('vendor.insufficientDataHint', { count: rating?.orderCount ?? 0 })} />
                      )}
                    </Card>

                    <Card size="small" title={t('vendor.sections.certificates')}>
                      {(vendor.certificates ?? []).length === 0 ? (
                        <EmptyState description={t('vendor.noCertificates')} />
                      ) : (
                        <Space direction="vertical" size={4}>
                          {(vendor.certificates ?? []).map((cert) => (
                            <Space key={cert.number} size={8}>
                              <Tag>{cert.kind}</Tag>
                              <Mono>{cert.number}</Mono>
                              <Typography.Text type="secondary">
                                <DateText value={cert.validTo} />
                              </Typography.Text>
                            </Space>
                          ))}
                        </Space>
                      )}
                    </Card>

                    <Card size="small" title={t('vendor.sections.contacts')}>
                      <Space direction="vertical" size={4}>
                        {(vendor.contacts ?? []).map((contact) => (
                          <Space key={contact.email} size={8} wrap>
                            <span>{contact.name}</span>
                            <Typography.Text type="secondary">{contact.role}</Typography.Text>
                            <Mono>{contact.email}</Mono>
                            {contact.phone ? <Mono>{contact.phone}</Mono> : null}
                          </Space>
                        ))}
                      </Space>
                    </Card>
                  </Space>
                </Col>
              </Row>
            ),
          },
          {
            key: 'prices',
            label: `${t('vendor.tabs.prices')} (${String(prices.length)})`,
            children: (
              <DataTable<VendorPrice>
                size="small"
                rowKey="id"
                columns={priceColumns}
                dataSource={prices}
                pagination={false}
                scroll={{ x: 900 }}
                locale={{ emptyText: <EmptyState description={t('catalog.noPrices')} /> }}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}
