import { useState, type JSX } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Input, Modal, Row, Segmented, Select, Space, Table, Tag,
  Typography, Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { InboxOutlined, UploadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import type { Discrepancy, VendorInvoice } from '@/api/types';
import { VENDOR_INVOICES } from '@/mocks/billing';
import { VENDOR_BY_ID } from '@/mocks/counterparties';
import { DateText, EmptyState, MoneyText, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

const DISCREPANCY_TOKEN: Record<string, keyof typeof STATUS_TOKENS> = {
  price_mismatch: 'warning',
  quantity_mismatch: 'warning',
  missing_on_our_side: 'critical',
  missing_on_their_side: 'critical',
};

/**
 * Сверка счетов поставщиков `[ТЗ 3.4.2]`.
 *
 * Сопоставление по ключу `поставщик + аэропорт + дата (±1 день) + код услуги`
 * с допуском 0.01 на округление (`DOMAIN.md § 7.7`). По каждому расхождению —
 * действие: принять счёт поставщика, оставить свою сумму и сформировать
 * претензию, пометить на разбор. **Все действия идут в аудит.**
 *
 * ADR-024: коды поставщика сопоставляются с каталогом через справочник;
 * неопознанные попадают в очередь сопоставления, а не молча теряются.
 */
export function ReconciliationPage(): JSX.Element {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(VENDOR_INVOICES[0]?.id ?? '');
  const [resolving, setResolving] = useState<{ invoice: VendorInvoice; index: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const invoice = VENDOR_INVOICES.find((i) => i.id === selectedId);
  const reconciliation = invoice?.reconciliation;
  const discrepancies = reconciliation?.discrepancies ?? [];

  const columns: ColumnsType<Discrepancy> = [
    {
      title: t('reconciliation.kind'),
      dataIndex: 'kind',
      width: 210,
      render: (value: string) => {
        const token = STATUS_TOKENS[DISCREPANCY_TOKEN[value] ?? 'warning'];
        return (
          <Tag style={{ color: token.color, background: token.background, borderColor: token.border }}>
            {t(`discrepancyKind.${value}`)}
          </Tag>
        );
      },
    },
    {
      title: t('reconciliation.line'),
      key: 'line',
      width: 200,
      render: (_, row) => {
        const line = row.lineIndex !== null && row.lineIndex !== undefined
          ? invoice?.lines[row.lineIndex]
          : undefined;
        return line ? (
          <Space direction="vertical" size={0}>
            <Mono>{line.serviceCode}</Mono>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Mono>{line.airportIcao}</Mono> · <DateText value={line.serviceDate} />
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">{t('reconciliation.noLine')}</Typography.Text>
        );
      },
    },
    {
      title: t('reconciliation.ours'),
      key: 'ours',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.ours ?? null} />,
    },
    {
      title: t('reconciliation.theirs'),
      key: 'theirs',
      width: 140,
      align: 'right',
      render: (_, row) => <MoneyText value={row.theirs ?? null} />,
    },
    {
      title: t('reconciliation.delta'),
      key: 'delta',
      width: 140,
      align: 'right',
      render: (_, row) => {
        if (!row.ours || !row.theirs) return <Typography.Text type="secondary">—</Typography.Text>;
        const delta = (
          Number.parseFloat(row.theirs.amount) - Number.parseFloat(row.ours.amount)
        ).toFixed(4);
        return <MoneyText value={{ amount: delta, currency: row.ours.currency }} colorBySign />;
      },
    },
    {
      title: t('reconciliation.resolution'),
      key: 'resolution',
      width: 190,
      render: (_, row) =>
        row.resolution ? (
          <Tag color="green">{t(`resolution.${row.resolution}`)}</Tag>
        ) : (
          <Typography.Text type="secondary">{t('reconciliation.unresolved')}</Typography.Text>
        ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      render: (_, row) => {
        const index = discrepancies.indexOf(row);
        return (
          <Button
            size="small"
            type="primary"
            disabled={Boolean(row.resolution)}
            onClick={() => {
              if (invoice) setResolving({ invoice, index });
            }}
          >
            {t('reconciliation.resolve')}
          </Button>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row align="middle" gutter={[8, 8]} wrap>
        <Col flex="auto">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nav.reconciliation')}
          </Typography.Title>
        </Col>
        <Col>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            onClick={() => {
              setImportOpen(true);
            }}
          >
            {t('reconciliation.import')}
          </Button>
        </Col>
      </Row>

      <Segmented
        value={selectedId}
        onChange={(value) => {
          setSelectedId(value);
        }}
        options={VENDOR_INVOICES.map((item) => ({
          value: item.id,
          label: `${VENDOR_BY_ID.get(item.vendorId)?.name ?? ''} · ${item.number}`,
        }))}
      />

      {!invoice ? (
        <Card>
          <EmptyState description={t('reconciliation.empty')} />
        </Card>
      ) : (
        <>
          <Card size="small">
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} bordered>
              <Descriptions.Item label={t('reconciliation.vendor')}>
                {VENDOR_BY_ID.get(invoice.vendorId)?.name}
              </Descriptions.Item>
              <Descriptions.Item label={t('reconciliation.invoiceNumber')}>
                <Mono>{invoice.number}</Mono>
              </Descriptions.Item>
              <Descriptions.Item label={t('reconciliation.totalOurs')}>
                <MoneyText value={reconciliation?.totalOurs} />
              </Descriptions.Item>
              <Descriptions.Item label={t('reconciliation.totalTheirs')}>
                <MoneyText value={reconciliation?.totalTheirs} />
              </Descriptions.Item>
              <Descriptions.Item label={t('reconciliation.matched')}>
                {reconciliation?.matched?.length ?? 0} {t('reconciliation.ofLines', { count: invoice.lines.length })}
              </Descriptions.Item>
              <Descriptions.Item label={t('reconciliation.discrepancies')}>
                <Tag color={discrepancies.length > 0 ? 'orange' : 'green'}>{discrepancies.length}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('reconciliation.delta')} span={2}>
                <MoneyText value={reconciliation?.delta} strong colorBySign />
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Alert
            type="info"
            showIcon
            message={t('reconciliation.toleranceNotice')}
          />

          {(invoice.unmappedCodes?.length ?? 0) > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={t('reconciliation.unmappedTitle', { count: invoice.unmappedCodes?.length ?? 0 })}
              description={
                <Space direction="vertical" size={4}>
                  <Space size={4} wrap>
                    {(invoice.unmappedCodes ?? []).map((code) => (
                      <Mono key={code}>{code}</Mono>
                    ))}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('reconciliation.unmappedHint')}
                  </Typography.Text>
                </Space>
              }
              action={<Button size="small">{t('reconciliation.mapCodes')}</Button>}
            />
          ) : null}

          <Card size="small" styles={{ body: { padding: 0 } }}>
            <Table<Discrepancy>
              size="small"
              rowKey={(row) => `${row.kind}_${String(row.lineIndex ?? 'x')}_${row.serviceOrderId ?? 'x'}`}
              columns={columns}
              dataSource={discrepancies}
              pagination={false}
              scroll={{ x: 1100 }}
              locale={{ emptyText: <EmptyState description={t('reconciliation.noDiscrepancies')} /> }}
            />
          </Card>
        </>
      )}

      <ResolveModal
        state={resolving}
        onClose={() => {
          setResolving(null);
        }}
      />

      <Modal
        open={importOpen}
        title={t('reconciliation.import')}
        okText={t('reconciliation.startImport')}
        cancelText={t('common.cancel')}
        onCancel={() => {
          setImportOpen(false);
        }}
        onOk={() => {
          setImportOpen(false);
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            placeholder={t('reconciliation.vendor')}
            options={VENDOR_INVOICES.map((i) => ({
              value: i.vendorId,
              label: VENDOR_BY_ID.get(i.vendorId)?.name ?? i.vendorId,
            }))}
          />
          <Upload.Dragger disabled style={{ padding: 8 }}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">{t('reconciliation.dropFile')}</p>
            <p className="ant-upload-hint">{t('reconciliation.dropFileHint')}</p>
          </Upload.Dragger>
          <Typography.Link>{t('reconciliation.downloadTemplate')}</Typography.Link>
        </Space>
      </Modal>
    </Space>
  );
}

function ResolveModal({
  state,
  onClose,
}: {
  state: { invoice: VendorInvoice; index: number } | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [resolution, setResolution] = useState<string>('accept_theirs');
  const [comment, setComment] = useState('');

  const discrepancy = state
    ? state.invoice.reconciliation?.discrepancies?.[state.index]
    : undefined;

  return (
    <Modal
      open={state !== null}
      title={t('reconciliation.resolveTitle')}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      onCancel={onClose}
      onOk={onClose}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {discrepancy ? (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={t('reconciliation.kind')}>
              {t(`discrepancyKind.${discrepancy.kind}`)}
            </Descriptions.Item>
            <Descriptions.Item label={t('reconciliation.ours')}>
              <MoneyText value={discrepancy.ours ?? null} />
            </Descriptions.Item>
            <Descriptions.Item label={t('reconciliation.theirs')}>
              <MoneyText value={discrepancy.theirs ?? null} />
            </Descriptions.Item>
          </Descriptions>
        ) : null}

        <Select
          style={{ width: '100%' }}
          value={resolution}
          onChange={setResolution}
          options={(['accept_theirs', 'keep_ours', 'claim', 'investigate'] as const).map((code) => ({
            value: code,
            label: t(`resolution.${code}`),
          }))}
        />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t(`resolutionHint.${resolution}`)}
        </Typography.Text>

        <Input.TextArea
          rows={3}
          placeholder={t('reconciliation.commentPlaceholder')}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
          }}
        />

        <Alert type="info" showIcon message={t('reconciliation.goesToAudit')} />
      </Space>
    </Modal>
  );
}
