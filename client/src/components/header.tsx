import { useState, useMemo, useEffect } from "react";
import { Search, Tv, Film, Calendar, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface SearchResult {
  resultType: 'show' | 'episode';
  id: number;
  name: string;
  image?: { medium?: string; original?: string };
  show?: {
    id: number;
    name: string;
  };
  season?: number;
  number?: number;
}

interface HeaderProps {
  onSearch?: (query: string) => void;
}

export default function Header({ onSearch }: HeaderProps) {
  const [location, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMode, setShowMode] = useState<"personal" | "shared">("personal");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const debouncedSearch = useDebounce(searchQuery, 300);
  const queryClient = useQueryClient();

  // Load show mode setting on mount
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

  // Handle show mode change
  const handleShowModeChange = async (newMode: string) => {
    if (newMode !== showMode && (newMode === 'personal' || newMode === 'shared')) {
      setShowMode(newMode as 'personal' | 'shared');
      
      try {
        await fetch('/api/user/settings', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ showMode: newMode }),
        });
        
        // Sync React Query cache with the new showMode value
        queryClient.setQueryData(['/api/user/settings'], (prev: any) => ({
          ...prev,
          showMode: newMode
        }));
        
        // Invalidate episode queries to trigger refetch with new showMode
        queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
        
      } catch (error) {
        console.error('Failed to update show mode:', error);
        // Revert local state on error
        setShowMode(showMode);
      }
    }
  };

  // Get untriaged episodes count for badge
  const { data: untriagedEpisodes } = useQuery({
    queryKey: ["/api/user/episodes", "untriaged"],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=untriaged`);
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json();
    },
  });

  const untriagedCount = untriagedEpisodes ? untriagedEpisodes.filter(
    (episode: any) => episode.episode.airdate // Only count episodes with air dates
  ).length : 0;

  const { data: searchResults, isLoading } = useQuery({
    queryKey: ['/api/search', debouncedSearch],
    queryFn: async () => {
      const response = await fetch(`/api/search?q=${encodeURIComponent(debouncedSearch)}`);
      if (!response.ok) {
        throw new Error('Search failed');
      }
      return response.json();
    },
    enabled: debouncedSearch.length >= 2,
    staleTime: 1000 * 15, // 15 seconds for fresher results
    refetchOnWindowFocus: true
  });

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    setShowDropdown(query.length >= 2);
    if (onSearch) {
      onSearch(query);
    }
  };

  const handleResultClick = (result: SearchResult) => {
    setSearchQuery("");
    setShowDropdown(false);
    // Navigate to show or episode detail page using wouter
    if (result.resultType === 'show') {
      setLocation(`/show/${result.id}`);
    } else {
      setLocation(`/episode/${result.id}`);
    }
  };

  const handleBlur = () => {
    // Delay hiding dropdown to allow for clicks
    setTimeout(() => setShowDropdown(false), 200);
  };

  const formatEpisodeTitle = (episode: SearchResult) => {
    if (episode.season && episode.number) {
      return `${episode.season}x${episode.number.toString().padStart(2, '0')}: ${episode.name}`;
    }
    return episode.name;
  };

  // Group and sort search results
  const groupedResults = useMemo(() => {
    if (!searchResults || searchResults.length === 0) {
      return { shows: [], episodes: [] };
    }

    const shows = searchResults
      .filter((result: SearchResult) => result.resultType === 'show')
      .sort((a: SearchResult, b: SearchResult) => 
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );

    const episodes = searchResults
      .filter((result: SearchResult) => result.resultType === 'episode')
      .sort((a: SearchResult, b: SearchResult) => 
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );

    return { shows, episodes };
  }, [searchResults]);

  const tabs = [
    { id: "dashboard", label: "Next Up", href: "/" },
    { id: "watch-later", label: "Watch Later", href: "/watch-later" },
    { id: "triage", label: "Triage", href: "/triage", showBadge: true },
    { id: "library", label: "Library", href: "/library" },
  ];

  const getActiveTab = () => {
    if (location === "/" || location === "/dashboard") return "dashboard";
    if (location === "/watch-later") return "watch-later";
    if (location === "/triage") return "triage";
    if (location === "/library" || location.startsWith("/show/") || location.startsWith("/episode/")) return "library";
    return "dashboard";
  };

  const activeTab = getActiveTab();

  return (
    <header className="bg-card border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" data-testid="link-home" className="flex items-center space-x-3 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <Tv className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold text-foreground">Front Row</h1>
          </Link>
          
          {/* Search Bar */}
          <div className="hidden md:block flex-1 max-w-lg mx-8">
            <div className="relative">
              <input 
                type="text" 
                placeholder="Search shows and episodes..."
                value={searchQuery}
                onChange={handleSearch}
                onBlur={handleBlur}
                onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
                data-testid="input-search-shows"
                className="w-full bg-muted text-foreground placeholder-muted-foreground border border-border rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
              <Search className="absolute left-3 top-2.5 h-5 w-5 text-muted-foreground" />
              
              {/* Search Dropdown */}
              {showDropdown && ((groupedResults.shows.length > 0 || groupedResults.episodes.length > 0) || isLoading) && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                  {isLoading ? (
                    <div className="p-4 text-sm text-muted-foreground">
                      Searching...
                    </div>
                  ) : (
                    <div className="py-2">
                      {/* Shows Section */}
                      {groupedResults.shows.length > 0 && (
                        <div data-testid="section-shows">
                          <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b border-border">
                            Shows ({groupedResults.shows.length})
                          </div>
                          {groupedResults.shows.map((result: SearchResult, index: number) => (
                            <button
                              key={`show-${result.id}`}
                              onClick={() => handleResultClick(result)}
                              data-testid={`item-show-${result.id}`}
                              className="w-full px-4 py-3 text-left hover:bg-muted flex items-center space-x-3"
                            >
                              <div className="w-8 h-8 bg-muted rounded overflow-hidden flex items-center justify-center">
                                {result.image?.medium ? (
                                  <img 
                                    src={result.image.medium} 
                                    alt={result.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <Tv className="w-4 h-4 text-muted-foreground" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-foreground truncate">
                                  {result.name}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  TV Show
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      
                      {/* Episodes Section */}
                      {groupedResults.episodes.length > 0 && (
                        <div data-testid="section-episodes">
                          <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b border-border">
                            Episodes ({groupedResults.episodes.length})
                          </div>
                          {groupedResults.episodes.map((result: SearchResult, index: number) => (
                            <button
                              key={`episode-${result.id}`}
                              onClick={() => handleResultClick(result)}
                              data-testid={`item-episode-${result.id}`}
                              className="w-full px-4 py-3 text-left hover:bg-muted flex items-center space-x-3"
                            >
                              <div className="w-8 h-8 bg-muted rounded overflow-hidden flex items-center justify-center">
                                {result.image?.medium ? (
                                  <img 
                                    src={result.image.medium} 
                                    alt={result.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <Film className="w-4 h-4 text-muted-foreground" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-foreground truncate">
                                  {formatEpisodeTitle(result)}
                                </div>
                                {result.show && (
                                  <div className="text-xs text-muted-foreground truncate">
                                    {result.show.name}
                                  </div>
                                )}
                                <div className="text-xs text-muted-foreground">
                                  Episode
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      
                      {/* No Results */}
                      {groupedResults.shows.length === 0 && groupedResults.episodes.length === 0 && (
                        <div className="p-4 text-sm text-muted-foreground text-center">
                          No results found
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          
          {/* Tab Navigation */}
          <nav className="hidden sm:flex space-x-1">
            {tabs.map((tab) => (
              <Link 
                key={tab.id}
                href={tab.href}
                data-testid={`button-tab-${tab.id}`}
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium transition-colors relative",
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
                {tab.showBadge && untriagedCount > 0 && (
                  <span className="absolute -top-2 -right-0 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {untriagedCount}
                  </span>
                )}
              </Link>
            ))}
          </nav>
          
          {/* Show Mode Selector */}
          {settingsLoaded && (
            <div className="flex items-center space-x-2 ml-4">
              <Users className="w-4 h-4 text-muted-foreground" />
              <Select value={showMode} onValueChange={handleShowModeChange} data-testid="select-show-mode">
                <SelectTrigger className="w-28 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        
        {/* Mobile Search */}
        <div className="md:hidden pb-4">
          <div className="relative">
            <input 
              type="text" 
              placeholder="Search shows and episodes..."
              value={searchQuery}
              onChange={handleSearch}
              onBlur={handleBlur}
              onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
              data-testid="input-search-shows-mobile"
              className="w-full bg-muted text-foreground placeholder-muted-foreground border border-border rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
            <Search className="absolute left-3 top-2.5 h-5 w-5 text-muted-foreground" />
            
            {/* Mobile Search Dropdown */}
            {showDropdown && ((groupedResults.shows.length > 0 || groupedResults.episodes.length > 0) || isLoading) && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto">
                {isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Searching...
                  </div>
                ) : (
                  <div className="py-2">
                    {/* Shows Section */}
                    {groupedResults.shows.length > 0 && (
                      <div data-testid="section-shows-mobile">
                        <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b border-border">
                          Shows ({groupedResults.shows.length})
                        </div>
                        {groupedResults.shows.map((result: SearchResult) => (
                          <button
                            key={`mobile-show-${result.id}`}
                            onClick={() => handleResultClick(result)}
                            data-testid={`item-show-mobile-${result.id}`}
                            className="w-full px-4 py-3 text-left hover:bg-muted flex items-center space-x-3"
                          >
                            <div className="w-8 h-8 bg-muted rounded overflow-hidden flex items-center justify-center">
                              {result.image?.medium ? (
                                <img 
                                  src={result.image.medium} 
                                  alt={result.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <Tv className="w-4 h-4 text-muted-foreground" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-foreground truncate">
                                {result.name}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                TV Show
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    
                    {/* Episodes Section */}
                    {groupedResults.episodes.length > 0 && (
                      <div data-testid="section-episodes-mobile">
                        <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b border-border">
                          Episodes ({groupedResults.episodes.length})
                        </div>
                        {groupedResults.episodes.map((result: SearchResult) => (
                          <button
                            key={`mobile-episode-${result.id}`}
                            onClick={() => handleResultClick(result)}
                            data-testid={`item-episode-mobile-${result.id}`}
                            className="w-full px-4 py-3 text-left hover:bg-muted flex items-center space-x-3"
                          >
                            <div className="w-8 h-8 bg-muted rounded overflow-hidden flex items-center justify-center">
                              {result.image?.medium ? (
                                <img 
                                  src={result.image.medium} 
                                  alt={result.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <Film className="w-4 h-4 text-muted-foreground" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-foreground truncate">
                                {formatEpisodeTitle(result)}
                              </div>
                              {result.show && (
                                <div className="text-xs text-muted-foreground truncate">
                                  {result.show.name}
                                </div>
                              )}
                              <div className="text-xs text-muted-foreground">
                                Episode
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    
                    {/* No Results */}
                    {groupedResults.shows.length === 0 && groupedResults.episodes.length === 0 && (
                      <div className="p-4 text-sm text-muted-foreground text-center">
                        No results found
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
