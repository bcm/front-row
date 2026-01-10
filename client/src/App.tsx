import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import AppShell from "@/components/app-shell";
import Dashboard from "./pages/dashboard";
import Library from "./pages/library";
import Shared from "./pages/shared";
import Join from "./pages/join";
import ShowDetail from "./pages/show-detail";
import EpisodeDetail from "./pages/episode-detail";
import NotFound from "./pages/not-found";
import Landing from "./pages/landing";
import { Loader2 } from "lucide-react";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/dashboard/:tab" component={Dashboard} />
      <Route path="/library" component={Library} />
      <Route path="/shared" component={Shared} />
      <Route path="/join/:inviteCode" component={Join} />
      <Route path="/show/:id" component={ShowDetail} />
      <Route path="/shows/:id" component={ShowDetail} />
      <Route path="/episode/:id" component={EpisodeDetail} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Landing />;
  }

  return (
    <AppShell>
      <Toaster />
      <Router />
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthenticatedApp />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
