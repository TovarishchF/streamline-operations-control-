import { useState, type JSX } from 'react';
import { Alert, Button, Card, Col, Row, Space, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { useFleet } from '@/api/fleet';
import type { Aircraft } from '@/api/types';
import { Can } from '@/shared/auth/Can';
import { useClock } from '@/shared/clock/useClock';
import { AircraftFormModal } from './AircraftFormModal';
import { EmptyState, Mono } from '@/shared/ui/primitives';
import { QueryState } from '@/shared/ui/QueryState';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  serviceable: 'done', maintenance: 'warning', aog: 'critical',
};

/**
 * Парк воздушных судов, техсостояние, AOG.
 *
 * ADR-009: `Aircraft.status` — факт о борте; `Flight.status='aog'` — следствие
 * для конкретного рейса. Перевод борта в AOG помечает все его будущие рейсы
 * конфликтом, но статус меняет только у подтверждённых диспетчером.
 *
 * ADR-027: допуски борта с датами — истёкший допуск даёт конфликт расписания.
 *
 * Клиент видит только свои борта: выборка ограничивается на сервере
 * (`BACKEND.md § 3.7`), а не фильтруется здесь.
 */
export function FleetPage(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();
  const [adding, setAdding] = useState(false);

  const query = useFleet();
  const aircraft = query.data?.data ?? [];
  const unserviceable = aircraft.filter((a) => a.status !== 'serviceable');

  const columns: DataColumns<Aircraft> = [
    {
      title: t('fleet.registration'), dataIndex: 'registration', width: 130, fixed: 'left',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('fleet.type'), key: 'type', width: 230,
      sortBy: (row) => row.type?.icaoType ?? '',
      render: (_, row) => {
        const type = row.type;
        return (
          <Space direction="vertical" size={0}>
            <span>{type?.name.ru}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Mono>{type?.icaoType}</Mono> · {t(`aircraftCategory.${type?.category ?? 'midsize'}`)}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: t('fleet.status'), dataIndex: 'status', width: 160,
      render: (value: string) => {
        const token = STATUS_TOKENS[TOKEN[value] ?? 'neutral'];
        return (
          <Tag style={{ color: token.color, background: token.background, borderColor: token.border, margin: 0 }}>
            {t(`aircraftStatus.${value}`)}
          </Tag>
        );
      },
    },
    {
      title: t('fleet.homeBase'), dataIndex: 'homeBaseIcao', width: 110,
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('fleet.seats'), key: 'seats', width: 90, align: 'right',
      sortBy: (row) => row.type?.seats ?? 0,
      render: (_, row) => <Mono>{row.type?.seats ?? '—'}</Mono>,
    },
    {
      title: t('fleet.turnaround'), key: 'turnaround', width: 130, align: 'right',
      sortBy: (row) => row.type?.turnaroundMin ?? 0,
      render: (_, row) => (
        <Tooltip title={t('fleet.turnaroundHint')}>
          <Mono>{row.type?.turnaroundMin ?? '—'} {t('common.minutesShort')}</Mono>
        </Tooltip>
      ),
    },
    {
      title: t('fleet.approvals'), key: 'approvals', width: 250,
      render: (_, row) => {
        const approvals = row.approvals ?? [];
        if (approvals.length === 0) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        return (
          <Space size={4} wrap>
            {approvals.map((approval) => {
              const expired = new Date(approval.validTo).getTime() < nowUtc.getTime();
              return (
                <Tooltip
                  key={`${approval.kind}:${approval.validFrom}`}
                  title={
                    <Space direction="vertical" size={0}>
                      <span>{approval.number}</span>
                      <span>
                        {t('contract.validTo')}: {new Date(approval.validTo).toLocaleDateString('ru-RU')}
                      </span>
                    </Space>
                  }
                >
                  <Tag color={expired ? 'red' : 'default'} style={{ margin: 0 }}>
                    {approval.kind}
                    {expired ? ' ⚠' : ''}
                  </Tag>
                </Tooltip>
              );
            })}
          </Space>
        );
      },
    },
    {
      title: t('fleet.notes'), dataIndex: 'notes', ellipsis: true,
      render: (value: string | null) => value ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.fleet')}</Typography.Title>
        </Col>
        <Col>
          <Can permission="flight.edit">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('fleet.add')}
            </Button>
          </Can>
        </Col>
      </Row>

      {unserviceable.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t('fleet.unserviceableNotice', { count: unserviceable.length })}
          description={unserviceable
            .map((a) => `${a.registration} — ${t(`aircraftStatus.${a.status}`)}`)
            .join(' · ')}
        />
      ) : null}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <QueryState query={query}>
          {(paged) => (
            <DataTable<Aircraft>
              size="small" rowKey="id" columns={columns} dataSource={paged.data}
              pagination={false} scroll={{ x: 1150 }}
              rowClassName={(row) => (row.status === 'aog' ? 'soc-row-critical' : '')}
              locale={{ emptyText: <EmptyState /> }}
            />
          )}
        </QueryState>
      </Card>

      <AircraftFormModal
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Space>
  );
}
