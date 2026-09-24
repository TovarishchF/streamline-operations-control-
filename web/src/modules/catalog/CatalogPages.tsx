import { useMemo, useState, type JSX } from 'react';
import { Button, Card, Col, Input, Row, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAirports, useServices, useVendorPrices, type VendorPriceRow } from '@/api/catalog';
import type { ServiceCatalogItem, ServiceCategory } from '@/api/types';
import { Can } from '@/shared/auth/Can';
import { ServiceFormModal } from './ServiceFormModal';
import { VendorPriceFormModal } from './VendorPriceFormModal';
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
const SERVICE_CATEGORIES: ServiceCategory[] = [
  'fuel',
  'handling',
  'catering',
  'transport',
  'permits',
  'deicing',
];

export function ServicesCatalogPage(): JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ServiceCategory | undefined>();
  const [adding, setAdding] = useState(false);

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
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.catalog')}
          </Typography.Title>
        </Col>
        <Col>
          <Can permission="catalog.edit">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('catalog.addService')}
            </Button>
          </Can>
        </Col>
      </Row>

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

      <ServiceFormModal
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Space>
  );
}

/**
 * Цены поставщиков по аэропортам `[ТЗ 3.2.1]`.
 *
 * Цена действует в периоде и **копируется** в заявку при назначении
 * поставщика (`CLAUDE.md § 3` п. 5). Правки здесь нет: новые условия —
 * это новый период, иначе изменение прайса переписало бы суммы в уже
 * оформленных заявках.
 */
export function VendorPricesPage(): JSX.Element {
  const { t } = useTranslation();
  const [airport, setAirport] = useState<string | undefined>();
  const [serviceId, setServiceId] = useState<string | undefined>();
  const [airportSearch, setAirportSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const services = useServices().data?.data ?? [];
  const airports = useAirports({ search: airportSearch, perPage: 30 }).data?.data ?? [];
  const serviceNames = new Map(services.map((service) => [service.id, service.name.ru]));

  // Фильтрация на сервере: прайс растёт быстрее справочника услуг,
  // и выкачивать его целиком ради двух выпадающих списков незачем.
  const query = useVendorPrices({
    ...(airport ? { airportIcao: airport } : {}),
    ...(serviceId ? { serviceId } : {}),
  });

  const columns: DataColumns<VendorPriceRow> = [
    {
      title: t('flight.airport'),
      dataIndex: 'airportIcao',
      // «Аэропорт» в IBM Plex Sans шире прежнего системного шрифта и в 90 px
      // разрывался посередине слова. Подпись не сокращается ради ширины —
      // расширяется колонка.
      width: 110,
      sorter: (a, b) => a.airportIcao.localeCompare(b.airportIcao),
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('service.name'),
      dataIndex: 'serviceId',
      render: (value: string, row) => serviceNames.get(value) ?? row.serviceCode,
    },
    {
      title: t('service.vendor'),
      dataIndex: 'vendorId',
      width: 210,
      render: (value: string, row) => <Link to={`/vendors/${value}`}>{row.vendorName}</Link>,
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
      render: (_, row) => <MoneyText value={row.minCharge} />,
    },
    {
      title: t('catalog.surcharges'),
      key: 'surcharges',
      width: 200,
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

  const addButton = (
    <Can permission="catalog.edit">
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setAdding(true);
        }}
      >
        {t('price.add')}
      </Button>
    </Can>
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.prices')}
          </Typography.Title>
        </Col>
        <Col>{addButton}</Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={8}>
            <Select
              allowClear
              showSearch
              filterOption={false}
              style={{ width: '100%' }}
              placeholder={t('flight.airport')}
              value={airport}
              onChange={setAirport}
              onSearch={setAirportSearch}
              options={airports.map((a) => ({ value: a.icao, label: `${a.icao} — ${a.city}` }))}
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
        <QueryState query={query}>
          {(paged) => (
            <DataTable<VendorPriceRow>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={paged.data}
              pagination={{ pageSize: 25, size: 'small' }}
              scroll={{ x: 1100 }}
              locale={{
                emptyText: (
                  <EmptyState description={t('catalog.noPrices')} action={addButton} />
                ),
              }}
            />
          )}
        </QueryState>
      </Card>

      <VendorPriceFormModal
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Space>
  );
}
