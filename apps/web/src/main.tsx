import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './styles/app.css';
import { App } from './App';
import { ApiError, initApi } from './lib/api';
import { TooltipProvider } from './ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [400, 401, 403, 404, 409].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
      staleTime: 20_000,
    },
  },
});

await initApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" toastOptions={{ className: '!bg-surface !text-ink !border-line !shadow-pop' }} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
