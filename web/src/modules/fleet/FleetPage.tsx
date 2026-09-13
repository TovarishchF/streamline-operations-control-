import type { JSX } from 'react';
import { Alert, Card, Space, Tag, Tooltip, Typography } from 'antd';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import type { Aircraft } from '@/api/types';
import { AIRCRAFT, AIRCRAFT_TYPE_BY_ID } from '@/mocks/reference';
import { FLIGHT_LIST } from '@/mocks/flights';
import { useClock } from '@/shared/clock/useClock';
import { EmptyState, Mono } from '@/shared/ui/primitives';
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
 */
export function FleetPage(): JSX.Element {
  const { t } = useTranslation();
  const { nowUtc } = useClock();

  const unserviceable = AIRCRAFT.filter((a) => a.status !== 'serviceable');

  const columns: DataColumns<Aircraft> = [
    {
      title: t('fleet.registration'), dataIndex: 'registration', width: 130, fixed: 'left',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('fleet.type'), dataIndex: 'typeId', width: 230,
      render: (value: string) => {
        const type = AIRCRAFT_TYPE_BY_ID.get(value);
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
      sortBy: (row) => AIRCRAFT_TYPE_BY_ID.get(row.typeId)?.seats ?? 0,
      render: (_, row) => <Mono>{AIRCRAFT_TYPE_BY_ID.get(row.typeId)?.seats ?? '—'}</Mono>,
    },
    {
      title: t('fleet.turnaround'), key: 'turnaround', width: 130, align: 'right',
      sortBy: (row) => AIRCRAFT_TYPE_BY_ID.get(row.typeId)?.turnaroundMin ?? 0,
      render: (_, row) => (
        <Tooltip title={t('fleet.turnaroundHint')}>
          <Mono>{AIRCRAFT_TYPE_BY_ID.get(row.typeId)?.turnaroundMin ?? '—'} {t('common.minutesShort')}</Mono>
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
                  key={approval.number}
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
      title: t('fleet.upcomingFlights'), key: 'flights', width: 120, align: 'right',
      sortBy: (row) => FLIGHT_LIST.filter((f) => f.aircraftId === row.id).length,
      render: (_, row) => <Mono>{FLIGHT_LIST.filter((f) => f.aircraftId === row.id).length}</Mono>,
    },
    {
      title: t('fleet.notes'), dataIndex: 'notes', ellipsis: true,
      render: (value: string | null) => value ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('nav.fleet')}</Typography.Title>

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
        <DataTable<Aircraft>
          size="small" rowKey="id" columns={columns} dataSource={AIRCRAFT}
          pagination={false} scroll={{ x: 1250 }}
          rowClassName={(row) => (row.status === 'aog' ? 'soc-row-critical' : '')}
          locale={{ emptyText: <EmptyState /> }}
        />
      </Card>
    </Space>
  );
}
