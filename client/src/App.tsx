import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "./pages/dashboard";
import WatchLater from "./pages/watch-later";
import Triage from "./pages/triage";
import Library from "./pages/library";
import Shared from "./pages/shared";
import SettingsPage from "./pages/settings";
import ShowDetail from "./pages/show-detail";
import EpisodeDetail from "./pages/episode-detail";
import NotFound from "./pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/watch-later" component={WatchLater} />
      <Route path="/triage" component={Triage} />
      <Route path="/library" component={Library} />
      <Route path="/shared" component={Shared} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/show/:id" component={ShowDetail} />
      <Route path="/shows/:id" component={ShowDetail} />
      <Route path="/episode/:id" component={EpisodeDetail} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="min-h-screen bg-background text-foreground">
          <Toaster />
          <Router />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
