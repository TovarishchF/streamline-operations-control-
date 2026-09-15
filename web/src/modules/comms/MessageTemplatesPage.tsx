import { useEffect, useState, type JSX } from 'react';
import {
  Alert, App, Button, Card, Col, Input, List, Modal, Row, Segmented, Space, Tag, Typography,
} from 'antd';
import { useTranslation } from 'react-i18next';

import {
  useMessageTemplates,
  useUpdateMessageTemplate,
  type MessageTemplateRow,
} from '@/api/comms';
import { EmptyState, Mono } from '@/shared/ui/primitives';
import { STATUS_TOKENS } from '@/shared/ui/status-tokens';

import { TemplatePreviewDrawer } from './TemplatePreviewDrawer';

type Locale = 'ru' | 'en';
type Draft = Pick<MessageTemplateRow, 'subject' | 'body'>;

/**
 * Шаблоны сообщений `[ТЗ 3.5.2]`.
 *
 * Шаблон редактируется, но сохранение требует подтверждения: шаблон уходит
 * всем получателям этого типа, и опечатка в нём — это опечатка в переписке
 * с десятками контрагентов. Перед сохранением показывается, что именно
 * изменилось.
 *
 * Язык письма выбирается по локали получателя, поэтому версии ru и en
 * редактируются раздельно и обе обязательны (ТЗ 4.5).
 */
export function MessageTemplatesPage(): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const query = useMessageTemplates();
  const updateTemplate = useUpdateMessageTemplate();
  const templates = query.data ?? [];

  const [selectedCode, setSelectedCode] = useState<string>('');
  const [locale, setLocale] = useState<Locale>('ru');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const selected =
    templates.find((template) => template.code === selectedCode) ?? templates[0];

  // Черновик сбрасывается при смене шаблона: редактирование одного шаблона
  // не должно случайно перетечь в другой.
  useEffect(() => {
    setDraft(selected ? { subject: { ...selected.subject }, body: { ...selected.body } } : null);
  }, [selected]);

  if (query.isLoading) {
    return <Card loading />;
  }

  if (!selected || !draft) {
    return (
      <Card>
        <EmptyState description={t('comms.noTemplates')} />
      </Card>
    );
  }

  const subjectChanged = draft.subject[locale] !== selected.subject[locale];
  const bodyChanged = draft.body[locale] !== selected.body[locale];
  const anyChanged =
    draft.subject.ru !== selected.subject.ru ||
    draft.subject.en !== selected.subject.en ||
    draft.body.ru !== selected.body.ru ||
    draft.body.en !== selected.body.en;

  const changedLocales = (['ru', 'en'] as const).filter(
    (code) => draft.subject[code] !== selected.subject[code] || draft.body[code] !== selected.body[code],
  );

  const discard = (): void => {
    setDraft({ subject: { ...selected.subject }, body: { ...selected.body } });
  };

  const commit = async (): Promise<void> => {
    try {
      await updateTemplate.mutateAsync({
        id: selected.id,
        subject: draft.subject,
        body: draft.body,
      });
      setConfirmOpen(false);
      void message.success(t('comms.templateSaved', { code: selected.code }));
    } catch {
      void message.error(t('common.saveFailed'));
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('nav.messageTemplates')}
      </Typography.Title>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Card size="small" styles={{ body: { padding: 0 } }}>
            <List
              dataSource={templates}
              renderItem={(template) => (
                <List.Item
                  key={template.code}
                  style={{
                    cursor: 'pointer',
                    paddingInline: 12,
                    background:
                      selectedCode === template.code ? STATUS_TOKENS.progress.background : undefined,
                  }}
                  onClick={() => {
                    if (anyChanged && template.code !== selectedCode) {
                      Modal.confirm({
                        title: t('comms.unsavedTitle'),
                        content: t('comms.unsavedHint'),
                        okText: t('comms.discardAndSwitch'),
                        cancelText: t('common.cancel'),
                        onOk: () => {
                          setSelectedCode(template.code);
                        },
                      });
                      return;
                    }
                    setSelectedCode(template.code);
                  }}
                >
                  <Space direction="vertical" size={0}>
                    <Mono>{template.code}</Mono>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {template.subject.ru}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          <Card
            size="small"
            title={
              <Space size={8}>
                <Mono>{selected.code}</Mono>
                {anyChanged ? <Tag color="orange">{t('comms.unsaved')}</Tag> : null}
              </Space>
            }
            extra={
              <Segmented
                size="small"
                value={locale}
                onChange={(value) => {
                  setLocale(value as Locale);
                }}
                options={[
                  { label: changedLocales.includes('ru') ? 'RU •' : 'RU', value: 'ru' },
                  { label: changedLocales.includes('en') ? 'EN •' : 'EN', value: 'en' },
                ]}
              />
            }
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('comms.subject')}
                  </Typography.Text>
                  {subjectChanged ? <Tag color="orange">{t('comms.changed')}</Tag> : null}
                </Space>
                <Input
                  value={draft.subject[locale]}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      subject: { ...draft.subject, [locale]: event.target.value },
                    });
                  }}
                />
              </Space>

              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('comms.body')}
                  </Typography.Text>
                  {bodyChanged ? <Tag color="orange">{t('comms.changed')}</Tag> : null}
                </Space>
                <Input.TextArea
                  value={draft.body[locale]}
                  rows={12}
                  onChange={(event) => {
                    setDraft({ ...draft, body: { ...draft.body, [locale]: event.target.value } });
                  }}
                />
              </Space>

              <Space direction="vertical" size={4}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('comms.variables')}
                </Typography.Text>
                <Space size={4} wrap>
                  {selected.variables.map((variable) => (
                    <Tag
                      key={variable}
                      style={{ margin: 0, cursor: 'pointer' }}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          body: {
                            ...draft.body,
                            [locale]: `${draft.body[locale]}{{${variable}}}`,
                          },
                        });
                      }}
                    >
                      <Mono>{`{{${variable}}}`}</Mono>
                    </Tag>
                  ))}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('comms.variablesHint')}
                </Typography.Text>
              </Space>

              <Alert type="info" showIcon message={t('comms.localeHint')} />

              <Space>
                <Button
                  type="primary"
                  disabled={!anyChanged}
                  onClick={() => {
                    setConfirmOpen(true);
                  }}
                >
                  {t('comms.saveTemplate')}
                </Button>
                <Button disabled={!anyChanged} onClick={discard}>
                  {t('comms.discard')}
                </Button>
                {/* Предпросмотр на настоящем рейсе `SPEC § 8.2`: собирает
                    сервер тем же сборщиком, что и отправку. */}
                <Button
                  onClick={() => {
                    setPreviewOpen(true);
                  }}
                >
                  {t('comms.preview')}
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* Подтверждение: шаблон уходит всем получателям этого типа */}
      <Modal
        open={confirmOpen}
        title={t('comms.confirmTitle')}
        okText={t('comms.confirmSave')}
        cancelText={t('common.cancel')}
        width={720}
        confirmLoading={updateTemplate.isPending}
        onCancel={() => {
          setConfirmOpen(false);
        }}
        onOk={() => {
          void commit();
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="warning" showIcon message={t('comms.confirmHint')} />

          <Typography.Text type="secondary">
            {t('comms.changedLocales', {
              locales: changedLocales.map((code) => code.toUpperCase()).join(', '),
            })}
          </Typography.Text>

          {changedLocales.map((code) => (
            <Card key={code} size="small" title={code.toUpperCase()}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {draft.subject[code] !== selected.subject[code] ? (
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('comms.subject')}
                    </Typography.Text>
                    <Typography.Text delete type="secondary">
                      {selected.subject[code]}
                    </Typography.Text>
                    <Typography.Text strong>{draft.subject[code]}</Typography.Text>
                  </Space>
                ) : null}

                {draft.body[code] !== selected.body[code] ? (
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('comms.body')}
                    </Typography.Text>
                    <pre
                      style={{
                        margin: 0,
                        maxHeight: 180,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        background: STATUS_TOKENS.neutral.background,
                        padding: 8,
                        borderRadius: 4,
                      }}
                    >
                      {draft.body[code]}
                    </pre>
                  </Space>
                ) : null}
              </Space>
            </Card>
          ))}
        </Space>
      </Modal>

      <TemplatePreviewDrawer
        open={previewOpen}
        template={selected}
        locale={locale}
        onClose={() => {
          setPreviewOpen(false);
        }}
      />
    </Space>
  );
}
