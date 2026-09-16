import { useState, type JSX } from 'react';
import { Alert, App, Form, Input, Modal, Select, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useCreateUser } from '@/api/admin';
import { useClients, useVendors } from '@/api/counterparties';
import { applyApiError } from '@/shared/ui/form-errors';

/** Роли из матрицы доступа `SPEC.md § 2.2`. */
const ROLES = ['admin', 'dispatcher', 'finance', 'manager', 'client', 'vendor'] as const;

/** Роли порталов: у них обязателен контрагент, иначе пользователь без данных. */
const PORTAL_ROLES = new Set(['client', 'vendor']);

interface FormValues {
  name: string;
  email: string;
  role: (typeof ROLES)[number];
  clientId?: string;
  vendorId?: string;
  locale: 'ru' | 'en';
}

/**
 * Заведение пользователя `[ТЗ 4.3]`.
 *
 * Пароль не задаётся: администратор, придумывающий пароль за человека,
 * получает один пароль на весь отдел. Учётная запись создаётся без него,
 * а вход настраивается отдельно.
 *
 * Роль портала требует контрагента: клиентский портал без клиента показал
 * бы пустой экран, а поставщик без поставщика — чужие заявки, если бы
 * фильтр вдруг ослаб. Поле обязательно именно поэтому.
 */
export function UserFormModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [banner, setBanner] = useState<string | null>(null);
  const [role, setRole] = useState<string>('dispatcher');

  const createUser = useCreateUser();
  const clients = useClients();
  const vendors = useVendors();

  const close = (): void => {
    form.resetFields();
    setBanner(null);
    setRole('dispatcher');
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setBanner(null);

    try {
      const created = await createUser.mutateAsync({
        name: values.name.trim(),
        email: values.email.trim().toLowerCase(),
        role: values.role,
        ...(values.clientId ? { clientId: values.clientId } : {}),
        ...(values.vendorId ? { vendorId: values.vendorId } : {}),
        locale: values.locale,
      });
      void message.success(t('admin.userCreated', { name: created.name }));
      close();
    } catch (error) {
      setBanner(applyApiError(error, form as never, t('common.saveFailed')));
    }
  };

  return (
    <Modal
      open={open}
      width={560}
      title={t('admin.addUser')}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      confirmLoading={createUser.isPending}
      onCancel={close}
      onOk={() => {
        void submit();
      }}
      destroyOnClose
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark preserve={false}>
        {banner ? (
          <Alert type="error" showIcon message={banner} style={{ marginBottom: 12 }} />
        ) : null}

        <Form.Item name="name" label={t('admin.name')} rules={[{ required: true }]}>
          <Input autoFocus placeholder="Иван Петров" />
        </Form.Item>

        <Form.Item
          name="email"
          label={t('admin.email')}
          tooltip={t('admin.emailHint')}
          rules={[{ required: true, type: 'email' }]}
        >
          <Input />
        </Form.Item>

        <Form.Item
          name="role"
          label={t('admin.role')}
          initialValue="dispatcher"
          rules={[{ required: true }]}
        >
          <Select
            options={ROLES.map((value) => ({ value, label: t(`roles.${value}`) }))}
            onChange={(value: string) => {
              setRole(value);
            }}
          />
        </Form.Item>

        {role === 'client' ? (
          <Form.Item name="clientId" label={t('flight.client')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={clients.isLoading}
              options={(clients.data?.data ?? []).map((client) => ({
                value: client.id,
                label: client.name,
              }))}
            />
          </Form.Item>
        ) : null}

        {role === 'vendor' ? (
          <Form.Item name="vendorId" label={t('service.vendor')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={vendors.isLoading}
              options={(vendors.data?.data ?? []).map((vendor) => ({
                value: vendor.id,
                label: vendor.name,
              }))}
            />
          </Form.Item>
        ) : null}

        <Form.Item
          name="locale"
          label={t('common.language')}
          initialValue="ru"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: 'ru', label: 'Русский' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {PORTAL_ROLES.has(role) ? t('admin.portalRoleHint') : t('admin.passwordHint')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
