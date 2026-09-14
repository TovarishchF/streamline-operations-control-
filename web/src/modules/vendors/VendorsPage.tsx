import { useMemo, useState, type JSX } from 'react';
import {
  Button, Card, Col, Input, Progress, Row, Select, Space, Tag, Tooltip, Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAirports } from '@/api/catalog';
import {
  useContracts,
  useVendors,
  type VendorContractRow,
  type VendorRow,
} from '@/api/counterparties';
import type { ServiceCategory, VendorRating } from '@/api/types';
import { Can } from '@/shared/auth/Can';
import { EmptyState, Mono } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';
import { VendorFormModal } from './VendorFormModal';

const SERVICE_CATEGORIES: ServiceCategory[] = [
  'fuel',
  'handling',
  'catering',
  'transport',
  'permits',
  'deicing',
];

/**
 * Рейтинг с разложением: цифра без объяснения выглядит выдуманной.
 *
 * `rating === undefined` означает, что сервер его не считал, а не что он
 * нулевой. Расчёт рейтинга — отдельная задача вехи M6 (`DOMAIN.md § 7.4`);
 * до неё здесь честно написано «данных недостаточно», а не выдуманный балл
 * (`CLAUDE.md § 4`).
 */
export function RatingCell({ rating }: { rating: VendorRating | null | undefined }): JSX.Element {
  const { t } = useTranslation();

  if (!rating?.sufficientData) {
    return (
      <Tooltip title={t('vendor.insufficientDataHint', { count: rating?.orderCount ?? 0 })}>
        <Typography.Text type="secondary">{t('vendor.insufficientData')}</Typography.Text>
      </Tooltip>
    );
  }

  const value = Number.parseFloat(rating.rating ?? '0');
  const color =
    value >= 4 ? STATUS_TOKENS.done.color : value >= 3 ? STATUS_TOKENS.warning.color : STATUS_TOKENS.critical.color;

  return (
    <Tooltip
      title={
        <Space direction="vertical" size={0}>
          <span>{t('vendor.onTimeConfirm')}: {(Number.parseFloat(rating.components?.onTimeConfirmRate ?? '0') * 100).toFixed(0)} %</span>
          <span>{t('vendor.slaCompliance')}: {(Number.parseFloat(rating.components?.slaComplianceRate ?? '0') * 100).toFixed(0)} %</span>
          <span>{t('vendor.billingAccuracy')}: {(Number.parseFloat(rating.components?.billingAccuracy ?? '0') * 100).toFixed(0)} %</span>
          <span>{t('vendor.qualityScore')}: {(Number.parseFloat(rating.components?.qualityScore ?? '0') * 5).toFixed(1)} / 5</span>
          <span style={{ opacity: 0.7 }}>{t('vendor.basedOn', { count: rating.orderCount })}</span>
        </Space>
      }
    >
      <Space size={6}>
        <Mono>{value.toFixed(2)}</Mono>
        <Progress
          percent={(value / 5) * 100}
          showInfo={false}
          size={[52, 5]}
          strokeColor={color}
        />
      </Space>
    </Tooltip>
  );
}

/** Реестр поставщиков `[ТЗ 3.3.1]`. */
export function VendorsPage(): JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ServiceCategory | undefined>();
  const [airport, setAirport] = useState<string | undefined>();
  const [airportSearch, setAirportSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const query = useVendors();
  const vendors = useMemo(() => query.data?.data ?? [], [query.data]);
  const airports = useAirports({ search: airportSearch, perPage: 30 }).data?.data ?? [];

  // Договоры одним запросом на всех поставщиков: по строке на каждого
  // было бы столько запросов, сколько строк в таблице.
  const contractsQuery = useContracts({});
  const contractByVendor = useMemo(() => {
    const map = new Map<string, VendorContractRow>();
    for (const contract of contractsQuery.data?.data ?? []) {
      const existing = map.get(contract.vendorId);
      // Показывается самый поздний по сроку: он и определяет, можно ли
      // заказывать у поставщика сегодня.
      if (!existing || contract.validTo > existing.validTo) map.set(contract.vendorId, contract);
    }
    return map;
  }, [contractsQuery.data]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return vendors.filter((vendor) => {
      if (needle && !`${vendor.name} ${vendor.legalName}`.toLowerCase().includes(needle)) {
        return false;
      }
      if (category && !vendor.specializations.includes(category)) return false;
      if (airport && !vendor.coverage.airports.includes(airport)) return false;
      return true;
    });
  }, [vendors, search, category, airport]);

  const columns: DataColumns<VendorRow> = [
    {
      title: t('vendor.name'),
      dataIndex: 'name',
      fixed: 'left',
      width: 220,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Link to={`/vendors/${row.id}`}>{value}</Link>
            {!row.isActive ? <Tag>{t('common.inactive')}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.legalName}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('vendor.specializations'),
      dataIndex: 'specializations',
      width: 240,
      render: (value: string[]) => (
        <Space size={4} wrap>
          {value.map((code) => (
            <Tag key={code} style={{ margin: 0 }}>
              {t(`serviceCategory.${code}`)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('vendor.coverage'),
      key: 'coverage',
      width: 190,
      sortBy: (row) => row.coverage.airports.length,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.coverage.airports.slice(0, 4).map((icao) => (
            <Mono key={icao}>{icao}</Mono>
          ))}
          {row.coverage.airports.length > 4 ? (
            <Typography.Text type="secondary">
              +{row.coverage.airports.length - 4}
            </Typography.Text>
          ) : null}
          {row.coverage.airports.length === 0 ? (
            <Typography.Text type="secondary">{t('vendor.global')}</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('vendor.rating'),
      key: 'rating',
      width: 150,
      // Рейтинг сервер пока не считает: сортировать нечего, и сортировка
      // по пустому значению только вводила бы в заблуждение.
      render: () => <RatingCell rating={null} />,
    },
    {
      title: t('vendor.currency'),
      dataIndex: 'settlementCurrency',
      width: 90,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('vendor.exchange'),
      dataIndex: 'exchangeMethod',
      width: 120,
      render: (value: string) => (
        <Tooltip title={t(`vendor.exchangeHint.${value}`)}>
          <Tag>{t(`vendor.exchangeMethod.${value}`)}</Tag>
        </Tooltip>
      ),
    },
    {
      title: t('contract.status'),
      key: 'contract',
      width: 140,
      render: (_, row) => {
        const contract = contractByVendor.get(row.id);
        if (!contract) return <Typography.Text type="secondary">—</Typography.Text>;
        const color =
          contract.status === 'expired' ? 'red' : contract.status === 'expiring' ? 'orange' : 'green';
        return (
          <Tooltip title={contract.number}>
            <Tag color={color}>{t(`contractStatus.${contract.status}`)}</Tag>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.vendors')}
          </Typography.Title>
        </Col>
        <Col>
          <Can permission="vendor.edit">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('vendor.add')}
            </Button>
          </Can>
        </Col>
      </Row>

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Row gutter={[8, 8]}>
          <Col xs={24} md={8}>
            <Input.Search
              allowClear
              placeholder={t('vendor.searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
            />
          </Col>
          <Col xs={12} md={8}>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder={t('vendor.specializations')}
              value={category}
              onChange={setCategory}
              options={SERVICE_CATEGORIES.map((code) => ({
                value: code,
                label: t(`serviceCategory.${code}`),
              }))}
            />
          </Col>
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
        </Row>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {() => (
            <DataTable<VendorRow>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={filtered}
              scroll={{ x: 1150 }}
              pagination={{ pageSize: 20, size: 'small' }}
              locale={{ emptyText: <EmptyState description={t('vendor.empty')} /> }}
            />
          )}
        </QueryState>
      </Card>

      <VendorFormModal
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Space>
  );
}
