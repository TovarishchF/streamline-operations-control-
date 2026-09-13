import type { JSX } from 'react';
import { ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import enUS from 'antd/locale/en_US';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { socTheme } from './theme';
import { AppRoutes } from './router';
import './app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

export function App(): JSX.Element {
  const { i18n } = useTranslation();
  const isEnglish = i18n.language.startsWith('en');

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={socTheme} locale={isEnglish ? enUS : ruRU}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
