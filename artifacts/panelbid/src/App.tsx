import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import JobDetail from '@/pages/job-detail';
import Settings from '@/pages/settings';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AuthGate } from '@/auth';

const queryClient = new QueryClient();

// When a session ends, nothing that was loaded stays in the page's memory.
const dropLoadedData = () => queryClient.clear();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/jobs/:id" component={JobDetail} />
      <Route path="/settings" component={Settings} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* Nothing of the app is drawn, and no data is asked for, until the
            server says this browser is signed in. */}
        <AuthGate onSignedOut={dropLoadedData}>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </AuthGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
