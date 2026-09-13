import { useMemo, useState, type JSX } from 'react';
import { Card, Col, Input, Row, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useServices } from '@/api/catalog';
import type { ServiceCatalogItem, ServiceCategory, VendorPrice } from '@/api/types';
import { VENDOR_BY_ID, VENDOR_PRICES } from '@/mocks/counterparties';
import { AIRPORTS, SERVICE_BY_ID, SERVICE_CATEGORIES } from '@/mocks/reference';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';

/**
 * Каталог услуг `[ТЗ 3.2.1]`.
 *
 * Дерево категорий строго по ТЗ: топливообеспечение, наземное обслуживание,
 * кейтеринг, транспорт, разрешительные документы, противообледенительная
 * обработка. Наименования — двумя полями ru/en (ADR-031).
 *
 * Категория фильтруется на сервере, поиск по названию — на клиенте:
 * каталог невелик и целиком помещается в память, а искать по двум языкам
 * запросом значило бы заводить эндпоинту ещё один параметр без нужды.
 */
export function ServicesCatalogPage(): JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ServiceCategory | undefined>();

  const query = useServices(category);
  const services = query.data?.data;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!services) return [];
    if (!needle) return services;
    return services.filter((service) =>
      `${service.name.ru} ${service.name.en} ${service.code}`.toLowerCase().includes(needle),
    );
  }, [search, services]);

  const columns: DataColumns<ServiceCatalogItem> = [
    {
      title: t('catalog.code'),
      dataIndex: 'code',
      width: 140,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('service.name'),
      key: 'name',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.name.ru}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.name.en}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('service.category'),
      dataIndex: 'category',
      width: 190,
      filters: SERVICE_CATEGORIES.map((code) => ({ text: t(`serviceCategory.${code}`), value: code })),
      onFilter: (value, row) => row.category === value,
      render: (value: string) => <Tag>{t(`serviceCategory.${value}`)}</Tag>,
    },
    {
      title: t('catalog.unit'),
      dataIndex: 'unit',
      width: 100,
      render: (value: string) => t(`serviceUnit.${value}`),
    },
    {
      title: t('catalog.leadTime'),
      dataIndex: 'leadTimeH',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.leadTimeH - b.leadTimeH,
      render: (value: number) => <Mono>{value} ч</Mono>,
    },
    {
      title: t('catalog.flags'),
      key: 'flags',
      width: 250,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.requiresWeather ? (
            <Tooltip title={t('catalog.requiresWeatherHint')}>
              <Tag color="blue" style={{ margin: 0 }}>
                {t('catalog.requiresWeather')}
              </Tag>
            </Tooltip>
          ) : null}
          {row.requiresActToComplete ? (
            <Tooltip title={t('catalog.requiresActHint')}>
              <Tag style={{ margin: 0 }}>{t('catalog.requiresAct')}</Tag>
            </Tooltip>
          ) : null}
          {(row.requiredAttributes ?? []).map((attr) => (
            <Tag key={attr.key} style={{ margin: 0 }} color="default">
              {attr.key}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.catalog')}
      </Typography.Title>

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={24} md={10}>
            <Input.Search
              allowClear
              placeholder={t('catalog.searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
          </Col>
          <Col xs={24} md={8}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder={t('service.category')}
              value={category}
              onChange={setCategory}
              options={SERVICE_CATEGORIES.map((code) => ({
                value: code,
                label: t(`serviceCategory.${code}`),
              }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {() => (
            <DataTable<ServiceCatalogItem>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={filtered}
              pagination={false}
              scroll={{ x: 1000 }}
              locale={{ emptyText: <EmptyState /> }}
            />
          )}
        </QueryState>
      </Card>
    </Space>
  );
}

/** Цены поставщиков по аэропортам `[ТЗ 3.2.1]`. */
export function VendorPricesPage(): JSX.Element {
  const { t } = useTranslation();
  const [airport, setAirport] = useState<string | undefined>();
  const [serviceId, setServiceId] = useState<string | undefined>();

  // Перечень услуг — настоящий, с сервера. Сами прайсы поставщиков появятся
  // вместе с реестром контрагентов (M6), пока они из набора для макетов.
  const services = useServices().data?.data ?? [];

  const filtered = useMemo(
    () =>
      VENDOR_PRICES.filter((price) => {
        if (airport && price.airportIcao !== airport) return false;
        if (serviceId && price.serviceId !== serviceId) return false;
        return true;
      }),
    [airport, serviceId],
  );

  const columns: DataColumns<VendorPrice> = [
    {
      title: t('flight.airport'),
      dataIndex: 'airportIcao',
      width: 90,
      sorter: (a, b) => a.airportIcao.localeCompare(b.airportIcao),
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('service.name'),
      dataIndex: 'serviceId',
      render: (value: string) => SERVICE_BY_ID.get(value)?.name.ru ?? value,
    },
    {
      title: t('service.vendor'),
      dataIndex: 'vendorId',
      width: 210,
      render: (value: string) => (
        <Link to={`/vendors/${value}`}>{VENDOR_BY_ID.get(value)?.name ?? value}</Link>
      ),
    },
    {
      title: t('catalog.unitPrice'),
      key: 'price',
      width: 140,
      align: 'right',
      sorter: (a, b) => Number.parseFloat(a.price.amount) - Number.parseFloat(b.price.amount),
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
      title: t('catalog.validity'),
      key: 'validity',
      width: 200,
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
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.prices')}
      </Typography.Title>

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={8}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('flight.airport')}
              value={airport}
              onChange={setAirport}
              options={AIRPORTS.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
            />
          </Col>
          <Col xs={12} md={10}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('service.name')}
              value={serviceId}
              onChange={setServiceId}
              options={services.map((service) => ({ value: service.id, label: service.name.ru }))}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<VendorPrice>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 25, size: 'small' }}
          scroll={{ x: 900 }}
          locale={{ emptyText: <EmptyState description={t('catalog.noPrices')} /> }}
        />
      </Card>
    </Space>
  );
}
