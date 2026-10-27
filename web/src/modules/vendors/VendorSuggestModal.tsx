import { useEffect, useState, type JSX } from 'react';
import { Alert, App, Input, Modal, Radio, Slider, Space, Tag, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { DataTable, type DataColumns } from '@/shared/ui/DataTable';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/client';
import {
  useVendorSuggest,
  type SuggestMode,
  type VendorCandidateRow,
} from '@/api/counterparties';
import type { Flight } from '@/api/flights';
import { assignOrderVendor, useReassignOrder, type ServiceOrderRow } from '@/api/orders';
import { useLocalizedName } from '@/shared/i18n/useLocalizedName';
import { MoneyText, Mono } from '@/shared/ui/primitives';
import { Notice } from '@/shared/ui/Notice';

type Weights = [number, number, number];

/**
 * Подбор поставщика `[ТЗ 3.3.2]`.
 *
 * Перед применением показывается таблица сравнения кандидатов с разложением
 * балла на составляющие и влиянием на маржу рейса: **решение должно быть
 * объяснимым** (`SPEC.md § 6.2`). Баллы считает сервер по `DOMAIN.md § 7.5`
 * (`POST /vendors/suggest`); поставщики без действующего контракта в подбор
 * не попадают.
 *
 * Назначить выбранного можно черновику (назначение) либо отклонённой или
 * отменённой заявке (переназначение). У заявки в работе подбор — только
 * сравнение: сменить поставщика у подтверждённой услуги нельзя.
 */
export function VendorSuggestModal({
  order,
  flight,
  onClose,
}: {
  order: ServiceOrderRow | null;
  flight: Flight;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const localized = useLocalizedName();
  const queryClient = useQueryClient();
  const reassign = useReassignOrder();

  const [mode, setMode] = useState<SuggestMode>('balanced');
  const [weights, setWeights] = useState<Weights>([0.5, 0.3, 0.2]);
  const [selected, setSelected] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    setSelected(null);
    setComment('');
  }, [order?.id]);

  const suggest = useVendorSuggest(
    order
      ? {
          serviceId: order.serviceId,
          airportIcao: order.airportIcao,
          onDate: order.leg === 'arrival' ? flight.staUtc : flight.stdUtc,
          quantity: order.quantity,
          flightId: flight.id,
          mode,
          ...(mode === 'custom'
            ? {
                weights: {
                  price: weights[0].toFixed(2),
                  rating: weights[1].toFixed(2),
                  proximity: weights[2].toFixed(2),
                },
              }
            : {}),
        }
      : null,
  );
  const candidates = suggest.data?.data ?? [];
  const chosen = selected ?? candidates[0]?.vendorId ?? null;

  const canAssign = order?.status === 'draft';
  const canReassign = order?.status === 'rejected' || order?.status === 'cancelled';
  const canApply = (canAssign || canReassign) && chosen !== null && chosen !== order.vendorId;

  const apply = async (): Promise<void> => {
    if (!order || !chosen) return;
    setAssigning(true);
    try {
      if (canAssign) {
        await assignOrderVendor({ id: order.id, vendorId: chosen });
        await queryClient.invalidateQueries({ queryKey: ['flight-orders', order.flightId] });
        await queryClient.invalidateQueries({ queryKey: ['flight-margin', order.flightId] });
      } else {
        await reassign.mutateAsync({ id: order.id, vendorId: chosen, comment });
      }
      void message.success(t('vendor.assigned'));
      onClose();
    } catch (error: unknown) {
      void message.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    } finally {
      setAssigning(false);
    }
  };

  const columns: DataColumns<VendorCandidateRow> = [
    {
      title: t('vendor.name'),
      dataIndex: 'vendorName',
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6} wrap>
            <span>{value}</span>
            {order?.vendorId === row.vendorId ? <Tag color="blue">{t('vendor.current')}</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.hasBaseAtAirport
              ? t('vendor.hasBase')
              : row.distanceKm === null
                ? t('vendor.distanceUnknown')
                : t('vendor.distanceKm', { km: row.distanceKm })}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('vendor.cost'),
      key: 'cost',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.cost} />,
    },
    {
      title: t('vendor.priceScore'),
      dataIndex: 'priceScore',
      width: 96,
      align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('vendor.ratingScore'),
      dataIndex: 'ratingScore',
      width: 96,
      align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('vendor.proximityScore'),
      dataIndex: 'proximityScore',
      width: 106,
      align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('vendor.totalScore'),
      dataIndex: 'totalScore',
      width: 100,
      align: 'right',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      title: t('vendor.marginImpact'),
      key: 'impact',
      width: 150,
      align: 'right',
      render: (_, row) => <MoneyText value={row.marginImpact} colorBySign />,
    },
  ];

  return (
    <Modal
      open={order !== null}
      width="min(980px, calc(100vw - 32px))"
      title={t('vendor.suggestTitle', { service: localized(order?.service?.name) })}
      okText={canReassign ? t('vendor.reassignSelected') : t('vendor.applySelected')}
      okButtonProps={{ disabled: !canApply, loading: assigning }}
      cancelText={t('common.close')}
      onCancel={onClose}
      onOk={() => {
        void apply();
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Radio.Group
          size="small"
          optionType="button"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as SuggestMode);
          }}
          options={[
            { label: t('vendor.presetPrice'), value: 'price' },
            { label: t('vendor.presetRating'), value: 'rating' },
            { label: t('vendor.presetProximity'), value: 'proximity' },
            { label: t('vendor.presetBalanced'), value: 'balanced' },
            { label: t('vendor.presetCustom'), value: 'custom' },
          ]}
        />

        {mode === 'custom' ? (
          <Space size={16} wrap style={{ width: '100%' }}>
            {(['price', 'rating', 'proximity'] as const).map((key, index) => (
              <Space key={key} direction="vertical" size={0} style={{ width: 190, maxWidth: '100%' }}>
                <Typography.Text style={{ fontSize: 12 }}>{t(`vendor.weight_${key}`)}</Typography.Text>
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  value={weights[index]}
                  onChange={(value: number) => {
                    const next: Weights = [...weights];
                    next[index] = value;
                    setWeights(next);
                  }}
                />
              </Space>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('vendor.presetHint')}
          </Typography.Text>
        )}

        {suggest.isError ? (
          <Alert
            type="error"
            showIcon
            message={suggest.error instanceof ApiError ? suggest.error.message : t('common.error')}
          />
        ) : !suggest.isPending && candidates.length === 0 ? (
          <Alert type="error" showIcon message={t('vendor.noCandidates')} />
        ) : (
          <DataTable<VendorCandidateRow>
            size="small"
            rowKey="vendorId"
            loading={suggest.isFetching}
            columns={columns}
            dataSource={candidates}
            pagination={false}
            scroll={{ x: 900 }}
            rowSelection={{
              type: 'radio',
              selectedRowKeys: chosen ? [chosen] : [],
              onChange: (keys) => {
                setSelected(keys[0] === undefined ? null : String(keys[0]));
              },
            }}
            rowClassName={(row) => (row.vendorId === order?.vendorId ? 'soc-row-current' : '')}
          />
        )}

        {canReassign ? (
          <Input.TextArea
            rows={2}
            value={comment}
            placeholder={t('vendor.reassignComment')}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        ) : null}

        {!canAssign && !canReassign && order ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('vendor.compareOnly')}
          </Typography.Text>
        ) : null}

        <Notice
          id="vendor.snapshot"
          type="info"
          showIcon
          message={t('vendor.snapshotNotice')}
          description={t('vendor.snapshotHint', { currency: flight.billingCurrency })}
        />
      </Space>
    </Modal>
  );
}
