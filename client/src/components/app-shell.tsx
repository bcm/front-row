import { useState, useMemo, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import AddShowDialog from "@/components/add-show-dialog";
import {
  Search,
  Tv,
  PlayCircle,
  Library,
  Users,
  User,
  Plus,
  LogOut,
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

export default function AppShell({ children }: AppShellProps) {
  const [location, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMode, setShowMode] = useState<"personal" | "shared">("personal");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const debouncedSearch = useDebounce(searchQuery, 300);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: userSettings } = useQuery({
    queryKey: ["/api/user/settings"],
    queryFn: async () => {
      const response = await fetch('/api/user/settings');
      if (!response.ok) throw new Error('Failed to fetch user settings');
      return response.json();
    },
  });

  useEffect(() => {
    if (userSettings?.showMode && (userSettings.showMode === 'personal' || userSettings.showMode === 'shared')) {
      setShowMode(userSettings.showMode);
    }
  }, [userSettings?.showMode]);

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
    queryKey: ["/api/user/episodes", "untriaged", showMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', 'untriaged');
      if (showMode) {
        params.set('showMode', showMode);
      }
      const response = await fetch(`/api/user/episodes?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json();
    },
    enabled: !!userSettings,
  });

  const untriagedCount = untriagedEpisodes ? untriagedEpisodes.filter(
    (episode: any) => episode.episode.airdate
  ).length : 0;

  const { data: pendingInvites = [] } = useQuery({
    queryKey: ["/api/invites/pending"],
    queryFn: async () => {
      const response = await fetch('/api/invites/pending');
      if (!response.ok) return [];
      return response.json();
    },
  });

  const pendingInviteCount = Array.isArray(pendingInvites) ? pendingInvites.length : 0;

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
    if (location === "/" || location === "/dashboard" || location.startsWith("/dashboard/")) return "dashboard";
    if (location === "/library" || location.startsWith("/show/") || location.startsWith("/episode/")) return "library";
    if (location === "/shared" || location.startsWith("/join/")) return "shared";
    return "dashboard";
  };

  const activeTab = getActiveTab();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="h-14 border-b border-border bg-card flex items-center px-2 sm:px-4 gap-2 sm:gap-4">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 sm:w-8 sm:h-8 bg-primary rounded-lg flex items-center justify-center">
            <Tv className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold hidden md:block">Front Row</span>
        </Link>

        <nav className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          <Link href="/">
            <Button
              variant={activeTab === "dashboard" ? "secondary" : "ghost"}
              size="sm"
              className="gap-1 sm:gap-2 px-2 sm:px-3 h-8"
              data-testid="nav-dashboard"
            >
              <PlayCircle className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
              {untriagedCount > 0 && (
                <Badge variant="destructive" className="ml-0.5 sm:ml-1 text-xs px-1 sm:px-1.5 py-0">
                  {untriagedCount}
                </Badge>
              )}
            </Button>
          </Link>
          <Link href="/library">
            <Button
              variant={activeTab === "library" ? "secondary" : "ghost"}
              size="sm"
              className="gap-1 sm:gap-2 px-2 sm:px-3 h-8"
              data-testid="nav-library"
            >
              <Library className="h-4 w-4" />
              <span className="hidden sm:inline">Library</span>
            </Button>
          </Link>
        </nav>

        <div className="flex items-center gap-1 sm:gap-2 flex-1 min-w-0 max-w-[140px] sm:max-w-xs md:max-w-md ml-auto">
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowDropdown(e.target.value.length >= 2);
              }}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
              data-testid="input-search"
              className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />

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
          <Button
            onClick={() => setShowAddDialog(true)}
            size="icon"
            className="h-8 w-8 shrink-0"
            data-testid="button-add-show"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="h-6 w-px bg-border mx-0.5 sm:mx-2 hidden sm:block" />

        <div className="flex items-center gap-0 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-8 w-8", showMode === 'personal' && "text-primary")}
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
                className={cn("h-8 w-8", showMode === 'shared' && "text-primary")}
                onClick={() => handleShowModeChange('shared')}
              >
                <Users className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Shared View</TooltipContent>
          </Tooltip>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full h-8 w-8 shrink-0">
              <Avatar className="h-7 w-7 sm:h-8 sm:w-8">
                <AvatarImage src={user?.profileImageUrl || undefined} alt={user?.firstName || "User"} />
                <AvatarFallback className="text-xs sm:text-sm">
                  {user?.firstName?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || "U"}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {user?.email}
              </p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/shared" className="w-full cursor-pointer flex items-center">
                <Users className="mr-2 h-4 w-4" />
                Groups
                {pendingInviteCount > 0 && (
                  <Badge variant="default" className="ml-auto text-xs px-1.5 py-0 bg-primary">
                    {pendingInviteCount}
                  </Badge>
                )}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="/api/logout" className="w-full cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <AddShowDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
      />

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
