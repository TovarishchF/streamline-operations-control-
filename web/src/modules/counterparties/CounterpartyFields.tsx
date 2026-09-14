/**
 * Поля, общие для карточек клиента, поставщика и договора.
 *
 * Вынесены потому, что используются тремя формами, а не про запас:
 * условия расчётов и список контактов в трёх местах разошлись бы
 * по составу проверок в первый же месяц.
 */
import type { JSX } from 'react';
import { Button, Col, Form, Input, InputNumber, Row, Select, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import type { CurrencyCode } from '@/api/types';

const PAYMENT_MODES = ['prepayment', 'postpayment', 'deferred'] as const;

/** Перечень поддерживаемых валют `[ТЗ 3.4.1]`. Совпадает с контрактом. */
export const CURRENCIES: CurrencyCode[] = ['RUB', 'USD', 'EUR'];

/**
 * Условия расчётов `[ТЗ 3.3]`.
 *
 * Поля зависят от способа: у отсрочки обязателен срок, у предоплаты —
 * доля. Сервер это проверит, но показывать поле, которое ни на что
 * не влияет, значит приглашать заполнить его зря.
 */
export function PaymentTermsFields({ namePrefix }: { namePrefix: string }): JSX.Element {
  const { t } = useTranslation();

  return (
    <Row gutter={12}>
      <Col xs={24} sm={8}>
        <Form.Item
          name={[namePrefix, 'mode']}
          label={t('counterparty.paymentMode')}
          rules={[{ required: true }]}
          initialValue="deferred"
        >
          <Select
            options={PAYMENT_MODES.map((mode) => ({
              value: mode,
              label: t(`paymentMode.${mode}`),
            }))}
          />
        </Form.Item>
      </Col>

      <Form.Item noStyle shouldUpdate>
        {({ getFieldValue }) => {
          const mode: string = getFieldValue([namePrefix, 'mode']) as string;
          return (
            <>
              {mode === 'deferred' ? (
                <Col xs={24} sm={8}>
                  <Form.Item
                    name={[namePrefix, 'deferDays']}
                    label={t('counterparty.deferDays')}
                    rules={[{ required: true, min: 1, type: 'number' }]}
                    initialValue={30}
                  >
                    <InputNumber min={1} max={365} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              ) : null}
              {mode === 'prepayment' ? (
                <Col xs={24} sm={8}>
                  <Form.Item
                    name={[namePrefix, 'prepaymentPercent']}
                    label={t('counterparty.prepaymentPercent')}
                    rules={[{ required: true, min: 1, max: 100, type: 'number' }]}
                    initialValue={50}
                  >
                    <InputNumber min={1} max={100} style={{ width: '100%' }} addonAfter="%" />
                  </Form.Item>
                </Col>
              ) : null}
            </>
          );
        }}
      </Form.Item>
    </Row>
  );
}

/**
 * Контактные лица `[ТЗ 3.3]`.
 *
 * Язык контакта — это язык, на котором ему уйдёт письмо (`DOMAIN.md § 9`),
 * а не язык интерфейса отправителя. Основной контакт ровно один.
 */
export function ContactsEditor(): JSX.Element {
  const { t } = useTranslation();

  return (
    <Form.List name="contacts">
      {(fields, { add, remove }) => (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {fields.map((field, index) => (
            <Row key={field.key} gutter={8} align="bottom">
              <Col xs={24} sm={7}>
                <Form.Item
                  name={[field.name, 'name']}
                  label={index === 0 ? t('counterparty.contactName') : undefined}
                  rules={[{ required: true }]}
                  style={{ marginBottom: 8 }}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={24} sm={6}>
                <Form.Item
                  name={[field.name, 'email']}
                  label={index === 0 ? t('counterparty.contactEmail') : undefined}
                  rules={[{ required: true, type: 'email' }]}
                  style={{ marginBottom: 8 }}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={12} sm={5}>
                <Form.Item
                  name={[field.name, 'role']}
                  label={index === 0 ? t('counterparty.contactRole') : undefined}
                  style={{ marginBottom: 8 }}
                >
                  <Input />
                </Form.Item>
              </Col>
              <Col xs={8} sm={4}>
                <Form.Item
                  name={[field.name, 'locale']}
                  label={index === 0 ? t('counterparty.contactLocale') : undefined}
                  initialValue="ru"
                  style={{ marginBottom: 8 }}
                >
                  <Select
                    options={[
                      { value: 'ru', label: 'ru' },
                      { value: 'en', label: 'en' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col xs={4} sm={2}>
                <Form.Item style={{ marginBottom: 8 }}>
                  <Button
                    icon={<DeleteOutlined />}
                    aria-label={t('common.remove')}
                    onClick={() => {
                      remove(field.name);
                    }}
                  />
                </Form.Item>
              </Col>
            </Row>
          ))}

          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() => {
              // Первый контакт становится основным: на него уходит переписка,
              // и оставлять её без адресата нельзя.
              add({ locale: 'ru', isPrimary: fields.length === 0 });
            }}
          >
            {t('counterparty.addContact')}
          </Button>

          {fields.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('counterparty.noContactsHint')}
            </Typography.Text>
          ) : null}
        </Space>
      )}
    </Form.List>
  );
}
