import { useState, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  Tv,
  PlayCircle,
  Library,
  Sparkles,
  Settings,
  Menu,
  ChevronLeft,
  Users,
  User,
} from "lucide-react";

interface SearchResult {
  resultType: 'show' | 'episode';
  id: number;
  name: string;
  image?: { medium?: string; original?: string };
  show?: { id: number; name: string };
  season?: number;
  number?: number;
}

interface AppShellProps {
  children: React.ReactNode;
}

const primaryNavItems = [
  { id: "dashboard", label: "Dashboard", href: "/", showBadge: true, icon: PlayCircle },
  { id: "library", label: "Library", href: "/library", icon: Library },
];

const discoverNavItems = [
  { id: "recommendations", label: "Recommendations", href: "/recommendations", icon: Sparkles },
];

const secondaryNavItems = [
  { id: "settings", label: "Settings", href: "/settings", icon: Settings },
];

export default function AppShell({ children }: AppShellProps) {
  const [location, setLocation] = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMode, setShowMode] = useState<"personal" | "shared">("personal");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const debouncedSearch = useDebounce(searchQuery, 300);
  const queryClient = useQueryClient();

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await fetch('/api/user/settings');
        if (response.ok) {
          const settings = await response.json();
          if (settings.showMode === 'personal' || settings.showMode === 'shared') {
            setShowMode(settings.showMode);
          }
        }
      } catch (error) {
        console.error('Failed to fetch user settings:', error);
      } finally {
        setSettingsLoaded(true);
      }
    };
    fetchSettings();
  }, []);

  const handleShowModeChange = async (newMode: string) => {
    if (newMode !== showMode && (newMode === 'personal' || newMode === 'shared')) {
      setShowMode(newMode as 'personal' | 'shared');
      try {
        await fetch('/api/user/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ showMode: newMode }),
        });
        queryClient.setQueryData(['/api/user/settings'], (prev: any) => ({
          ...(prev ?? {}),
          showMode: newMode
        }));
        queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes/upcoming"] });
      } catch (error) {
        console.error('Failed to update show mode:', error);
        setShowMode(showMode);
      }
    }
  };

  const { data: untriagedEpisodes } = useQuery({
    queryKey: ["/api/user/episodes", "untriaged"],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=untriaged`);
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json();
    },
  });

  const untriagedCount = untriagedEpisodes ? untriagedEpisodes.filter(
    (episode: any) => episode.episode.airdate
  ).length : 0;

  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: ['/api/search', debouncedSearch],
    queryFn: async () => {
      const response = await fetch(`/api/search?q=${encodeURIComponent(debouncedSearch)}`);
      if (!response.ok) throw new Error('Search failed');
      return response.json();
    },
    enabled: debouncedSearch.length >= 2,
    staleTime: 1000 * 15,
  });

  const groupedResults = useMemo(() => {
    if (!searchResults || searchResults.length === 0) {
      return { shows: [], episodes: [] };
    }
    const shows = searchResults.filter((r: SearchResult) => r.resultType === 'show');
    const episodes = searchResults.filter((r: SearchResult) => r.resultType === 'episode');
    return { shows, episodes };
  }, [searchResults]);

  const handleResultClick = (result: SearchResult) => {
    setSearchQuery("");
    setShowDropdown(false);
    if (result.resultType === 'show') {
      setLocation(`/show/${result.id}`);
    } else {
      setLocation(`/episode/${result.id}`);
    }
  };

  const getActiveTab = () => {
    if (location === "/" || location === "/dashboard") return "dashboard";
    if (location === "/library" || location.startsWith("/show/") || location.startsWith("/episode/")) return "library";
    if (location === "/recommendations") return "recommendations";
    if (location === "/settings") return "settings";
    return "dashboard";
  };

  const activeTab = getActiveTab();

  const NavItem = ({ item, collapsed = false }: { item: typeof primaryNavItems[0]; collapsed?: boolean }) => {
    const isActive = activeTab === item.id;
    const Icon = item.icon;
    
    return (
      <Link href={item.href}>
        <div
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors",
            isActive 
              ? "bg-primary text-primary-foreground" 
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          data-testid={`nav-${item.id}`}
          onClick={() => setMobileMenuOpen(false)}
        >
          <Icon className="h-5 w-5 flex-shrink-0" />
          {!collapsed && (
            <span className="flex-1 text-sm font-medium">{item.label}</span>
          )}
          {!collapsed && item.showBadge && untriagedCount > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">
              {untriagedCount}
            </Badge>
          )}
        </div>
      </Link>
    );
  };

  const SidebarContent = ({ collapsed = false }: { collapsed?: boolean }) => (
    <div className="flex flex-col h-full">
      <div className={cn("p-4", collapsed && "px-2")}>
        <Link href="/" className="flex items-center gap-3" onClick={() => setMobileMenuOpen(false)}>
          <div className="w-9 h-9 bg-primary rounded-lg flex items-center justify-center flex-shrink-0">
            <Tv className="w-5 h-5 text-primary-foreground" />
          </div>
          {!collapsed && <span className="text-lg font-bold">Front Row</span>}
        </Link>
      </div>

      <nav className={cn("flex-1 px-3 space-y-6", collapsed && "px-2")}>
        <div>
          {!collapsed && (
            <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Main
            </div>
          )}
          <div className="space-y-1">
            {primaryNavItems.map(item => (
              <NavItem key={item.id} item={item} collapsed={collapsed} />
            ))}
          </div>
        </div>

        <div>
          {!collapsed && (
            <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Discover
            </div>
          )}
          <div className="space-y-1">
            {discoverNavItems.map(item => (
              <NavItem key={item.id} item={item} collapsed={collapsed} />
            ))}
          </div>
        </div>

        <div>
          {!collapsed && (
            <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              More
            </div>
          )}
          <div className="space-y-1">
            {secondaryNavItems.map(item => (
              <NavItem key={item.id} item={item} collapsed={collapsed} />
            ))}
          </div>
        </div>
      </nav>

      {!collapsed && (
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {showMode === 'personal' ? <User className="h-4 w-4" /> : <Users className="h-4 w-4" />}
            <Select value={showMode} onValueChange={handleShowModeChange}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Personal</SelectItem>
                <SelectItem value="shared">Shared</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {!collapsed && (
        <button
          onClick={() => setSidebarCollapsed(true)}
          className="hidden lg:flex items-center justify-center p-3 border-t border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4 mr-2" />
          <span className="text-sm">Collapse</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex">
      <aside className={cn(
        "hidden lg:flex flex-col border-r border-border bg-card transition-all duration-300",
        sidebarCollapsed ? "w-16" : "w-64"
      )}>
        {sidebarCollapsed ? (
          <div className="flex flex-col h-full">
            <div className="p-3">
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="w-9 h-9 bg-primary rounded-lg flex items-center justify-center"
              >
                <Tv className="w-5 h-5 text-primary-foreground" />
              </button>
            </div>
            <nav className="flex-1 px-2 space-y-1 mt-4">
              {[...primaryNavItems, ...discoverNavItems, ...secondaryNavItems].map(item => (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <div>
                      <NavItem item={item} collapsed />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {item.label}
                    {item.id === 'dashboard' && untriagedCount > 0 && ` (${untriagedCount})`}
                  </TooltipContent>
                </Tooltip>
              ))}
            </nav>
          </div>
        ) : (
          <SidebarContent />
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-card flex items-center px-4 gap-4">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SidebarContent />
            </SheetContent>
          </Sheet>

          <div className="flex-1 max-w-md relative">
            <input
              type="text"
              placeholder="Search shows and episodes..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowDropdown(e.target.value.length >= 2);
              }}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
              data-testid="input-search"
              className="w-full bg-muted border border-border rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />

            {showDropdown && (groupedResults.shows.length > 0 || groupedResults.episodes.length > 0 || searchLoading) && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto">
                {searchLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">Searching...</div>
                ) : (
                  <div className="py-2">
                    {groupedResults.shows.length > 0 && (
                      <>
                        <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase">
                          Shows ({groupedResults.shows.length})
                        </div>
                        {groupedResults.shows.map((result: SearchResult) => (
                          <button
                            key={`show-${result.id}`}
                            onClick={() => handleResultClick(result)}
                            className="w-full px-4 py-2 text-left hover:bg-muted flex items-center gap-3"
                          >
                            <div className="w-8 h-8 bg-muted rounded overflow-hidden flex items-center justify-center">
                              {result.image?.medium ? (
                                <img src={result.image.medium} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <Tv className="w-4 h-4 text-muted-foreground" />
                              )}
                            </div>
                            <span className="text-sm truncate">{result.name}</span>
                          </button>
                        ))}
                      </>
                    )}
                    {groupedResults.episodes.length > 0 && (
                      <>
                        <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase">
                          Episodes ({groupedResults.episodes.length})
                        </div>
                        {groupedResults.episodes.map((result: SearchResult) => (
                          <button
                            key={`episode-${result.id}`}
                            onClick={() => handleResultClick(result)}
                            className="w-full px-4 py-2 text-left hover:bg-muted flex items-center gap-3"
                          >
                            <div className="w-8 h-8 bg-muted rounded flex items-center justify-center">
                              <PlayCircle className="w-4 h-4 text-muted-foreground" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm truncate">{result.name}</div>
                              {result.show && (
                                <div className="text-xs text-muted-foreground truncate">{result.show.name}</div>
                              )}
                            </div>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="hidden sm:flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(showMode === 'personal' && "text-primary")}
                  onClick={() => handleShowModeChange('personal')}
                >
                  <User className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Personal View</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(showMode === 'shared' && "text-primary")}
                  onClick={() => handleShowModeChange('shared')}
                >
                  <Users className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Shared View</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
