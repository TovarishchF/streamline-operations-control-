import { useState, type JSX } from 'react';
import {
  Button, Card, Col, Descriptions, Row, Skeleton, Space, Tabs, Tag, Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useServices, useVendorPrices, type VendorPriceRow } from '@/api/catalog';
import { useContracts, useVendor } from '@/api/counterparties';
import { ContractFormModal } from '@/modules/contracts/ContractFormModal';
import { VendorPriceFormModal } from '@/modules/catalog/VendorPriceFormModal';
import { NotFoundPage } from '@/modules/misc/NotFoundPage';
import { Can } from '@/shared/auth/Can';
import { DateText, EmptyState, Field, MoneyText, Mono } from '@/shared/ui/primitives';

/**
 * Профиль поставщика `[ТЗ 3.3.1]`.
 *
 * Рейтинг с разложением на составляющие (`DOMAIN.md § 7.4`) сервер пока
 * не считает — это отдельная задача вехи M6. До неё здесь написано
 * «данных недостаточно», а не выдуманный балл (`CLAUDE.md § 4`).
 */
export function VendorCardPage(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [addingPrice, setAddingPrice] = useState(false);
  const [addingContract, setAddingContract] = useState(false);

  const vendorQuery = useVendor(id);
  const contracts = useContracts({ vendorId: id }).data?.data ?? [];
  const prices = useVendorPrices({ vendorId: id }).data?.data ?? [];
  const serviceNames = new Map(
    (useServices().data?.data ?? []).map((service) => [service.id, service.name.ru]),
  );

  const priceColumns: DataColumns<VendorPriceRow> = [
    {
      title: t('service.name'),
      dataIndex: 'serviceId',
      render: (value: string, row) => serviceNames.get(value) ?? row.serviceCode,
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
      render: (_, row) => <MoneyText value={row.minCharge} />,
    },
    {
      title: t('catalog.surcharges'),
      key: 'surcharges',
      width: 220,
      render: (_, row) =>
        row.surcharges.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.surcharges.map((surcharge) => (
              <Tag key={surcharge.code} style={{ margin: 0 }}>
                {t(`surcharge.${surcharge.code}`)} +
                {Number.parseFloat(surcharge.value).toFixed(0)}
                {surcharge.kind === 'percent' ? '%' : ''}
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

  if (vendorQuery.isPending) return <Skeleton active paragraph={{ rows: 8 }} />;

  const vendor = vendorQuery.data;
  if (!vendor) return <NotFoundPage />;

  // Самый поздний по сроку: он и определяет, можно ли заказывать сегодня.
  const contract = [...contracts].sort((a, b) => b.validTo.localeCompare(a.validTo))[0];

  const addPriceButton = (
    <Can permission="catalog.edit">
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setAddingPrice(true);
        }}
      >
        {t('price.add')}
      </Button>
    </Can>
  );

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
                <Typography.Text type="secondary">
                  {t('vendor.insufficientData')}
                </Typography.Text>
              </Field>
              <Field label={t('vendor.manualScore')}>
                <Mono>{vendor.manualQualityScore} / 5</Mono>
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
                        {t(`paymentMode.${vendor.paymentTerms.mode}`)},{' '}
                        {vendor.paymentTerms.deferDays} {t('common.days')}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('vendor.exchange')}>
                        <Tag>{t(`vendor.exchangeMethod.${vendor.exchangeMethod}`)}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('vendor.coverage')}>
                        {vendor.coverage.airports.length === 0 ? (
                          <Typography.Text type="secondary">{t('vendor.global')}</Typography.Text>
                        ) : (
                          <Space size={4} wrap>
                            {vendor.coverage.airports.map((icao) => (
                              <Mono key={icao}>{icao}</Mono>
                            ))}
                          </Space>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('contract.number')}>
                        {contract ? (
                          <Space size={6} wrap>
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
                          <Can
                            permission="contract.edit"
                            fallback={<Typography.Text type="secondary">—</Typography.Text>}
                          >
                            <Button
                              size="small"
                              icon={<PlusOutlined />}
                              onClick={() => {
                                setAddingContract(true);
                              }}
                            >
                              {t('contract.add')}
                            </Button>
                          </Can>
                        )}
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                </Col>

                <Col xs={24} lg={12}>
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Card size="small" title={t('vendor.sections.rating')}>
                      <EmptyState description={t('vendor.ratingNotComputed')} />
                    </Card>

                    <Card size="small" title={t('vendor.sections.certificates')}>
                      {vendor.certificates.length === 0 ? (
                        <EmptyState description={t('vendor.noCertificates')} />
                      ) : (
                        <Space direction="vertical" size={4}>
                          {vendor.certificates.map((cert) => (
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
                      {vendor.contacts.length === 0 ? (
                        <EmptyState description={t('counterparty.noContactsHint')} />
                      ) : (
                        <Space direction="vertical" size={4}>
                          {vendor.contacts.map((contact) => (
                            <Space key={contact.email} size={8} wrap>
                              <span>{contact.name}</span>
                              <Typography.Text type="secondary">{contact.role}</Typography.Text>
                              <Mono>{contact.email}</Mono>
                              {contact.phone ? <Mono>{contact.phone}</Mono> : null}
                            </Space>
                          ))}
                        </Space>
                      )}
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
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {addPriceButton}
                <DataTable<VendorPriceRow>
                  size="small"
                  rowKey="id"
                  columns={priceColumns}
                  dataSource={prices}
                  pagination={false}
                  scroll={{ x: 900 }}
                  locale={{
                    emptyText: (
                      <EmptyState description={t('catalog.noPrices')} action={addPriceButton} />
                    ),
                  }}
                />
              </Space>
            ),
          },
        ]}
      />

      <VendorPriceFormModal
        open={addingPrice}
        vendorId={vendor.id}
        onClose={() => {
          setAddingPrice(false);
        }}
      />
      <ContractFormModal
        open={addingContract}
        vendorId={vendor.id}
        onClose={() => {
          setAddingContract(false);
        }}
      />
    </Space>
  );
}
