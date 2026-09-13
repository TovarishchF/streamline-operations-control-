import { useMemo, useState, type JSX } from 'react';
import { Alert, Card, Input, Space, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { Airport } from '@/api/types';
import { AIRPORTS, AIRPORT_UTC_OFFSET } from '@/mocks/reference';
import { EmptyState, Mono } from '@/shared/ui/primitives';

/**
 * Справочник аэропортов.
 *
 * `CLAUDE.md § 4`: это **реальные** общедоступные данные — коды, координаты
 * и часовые пояса (OurAirports, общественное достояние). Вымышлены только
 * наименования контрагентов, а не справочные данные.
 *
 * Данные по FBO, перронам и рабочим часам служб ведутся вручную в реестре
 * поставщиков — это штатное решение, а не временная мера
 * (`INTEGRATIONS.md § 2.4`).
 */
export function AirportsPage(): JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return AIRPORTS;
    return AIRPORTS.filter((airport) =>
      `${airport.icao} ${airport.iata ?? ''} ${airport.name.ru} ${airport.name.en} ${airport.city}`
        .toLowerCase()
        .includes(query),
    );
  }, [search]);

  const columns: DataColumns<Airport> = [
    {
      title: 'ICAO', dataIndex: 'icao', width: 90, fixed: 'left',
      sorter: (a, b) => a.icao.localeCompare(b.icao),
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: 'IATA', dataIndex: 'iata', width: 80,
      render: (value: string | null) =>
        value ? <Mono>{value}</Mono> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('airport.name'), key: 'name', width: 260,
      sortBy: (row) => row.name.ru,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.name.ru}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.name.en}
          </Typography.Text>
        </Space>
      ),
    },
    { title: t('airport.city'), dataIndex: 'city', width: 170 },
    {
      title: t('airport.country'), dataIndex: 'country', width: 100,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('airport.timezone'), dataIndex: 'timezone', width: 200,
      render: (value: string, row) => {
        const offset = AIRPORT_UTC_OFFSET[row.icao] ?? 0;
        return (
          <Space direction="vertical" size={0}>
            <Mono>{value}</Mono>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Mono>UTC{offset >= 0 ? '+' : ''}{offset}</Mono>
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('airport.coordinates'), key: 'coords', width: 180,
      sortBy: (row) => row.lat,
      render: (_, row) => (
        <Tooltip title={t('airport.coordinatesHint')}>
          <Mono>
            {row.lat.toFixed(4)}, {row.lon.toFixed(4)}
          </Mono>
        </Tooltip>
      ),
    },
    {
      title: t('airport.elevation'), dataIndex: 'elevationFt', width: 110, align: 'right',
      render: (value: number) => <Mono>{value} ft</Mono>,
    },
    {
      title: t('airport.coordinated'), dataIndex: 'isCoordinated', width: 160,
      render: (value: boolean) =>
        value ? (
          <Tooltip title={t('airport.coordinatedHint')}>
            <Tag color="blue" style={{ margin: 0 }}>{t('airport.slotRequired')}</Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.airports')}</Typography.Title>

      <Alert type="info" showIcon message={t('airport.realDataNotice')} />

      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Input.Search
          allowClear
          placeholder={t('airport.searchPlaceholder')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          style={{ maxWidth: 420 }}
        />
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <DataTable<Airport>
          size="small" rowKey="id" columns={columns} dataSource={filtered}
          pagination={{ pageSize: 20, size: 'small' }} scroll={{ x: 1350 }}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
