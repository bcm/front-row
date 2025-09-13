import { useState, useMemo } from "react";
import { Search, Tv, Film, Calendar } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";

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
  const [location] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const debouncedSearch = useDebounce(searchQuery, 300);

  const { data: searchResults, isLoading } = useQuery({
    queryKey: ['/api/search', debouncedSearch],
    enabled: debouncedSearch.length >= 2,
    staleTime: 1000 * 60 * 5, // 5 minutes
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
    // Navigate to show or episode detail page
    if (result.resultType === 'show') {
      window.location.href = `/show/${result.id}`;
    } else {
      window.location.href = `/episode/${result.id}`;
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

  const tabs = [
    { id: "dashboard", label: "Dashboard", href: "/" },
    { id: "library", label: "Library", href: "/library" },
    { id: "shared", label: "Shared", href: "/shared" },
    { id: "settings", label: "Settings", href: "/settings" },
  ];

  const getActiveTab = () => {
    if (location === "/" || location === "/dashboard") return "dashboard";
    if (location === "/library") return "library";
    if (location === "/shared") return "shared";
    if (location === "/settings") return "settings";
    return "dashboard";
  };

  const activeTab = getActiveTab();

  return (
    <header className="bg-card border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <Tv className="w-5 h-5 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold text-foreground">Front Row</h1>
          </div>
          
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
              {showDropdown && (searchResults?.length > 0 || isLoading) && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                  {isLoading ? (
                    <div className="p-4 text-sm text-muted-foreground">
                      Searching...
                    </div>
                  ) : (
                    <div className="py-2">
                      {searchResults?.map((result: SearchResult, index: number) => (
                        <button
                          key={`${result.resultType}-${result.id}`}
                          onClick={() => handleResultClick(result)}
                          data-testid={`search-result-${result.resultType}-${index}`}
                          className="w-full px-4 py-3 text-left hover:bg-muted flex items-center space-x-3"
                        >
                          <div className="w-8 h-8 bg-muted rounded flex items-center justify-center">
                            {result.resultType === 'show' ? (
                              <Tv className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <Film className="w-4 h-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-foreground truncate">
                              {result.resultType === 'episode' ? formatEpisodeTitle(result) : result.name}
                            </div>
                            {result.resultType === 'episode' && result.show && (
                              <div className="text-xs text-muted-foreground truncate">
                                {result.show.name}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground">
                              {result.resultType === 'show' ? 'TV Show' : 'Episode'}
                            </div>
                          </div>
                        </button>
                      ))}
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
                  "px-4 py-2 rounded-md text-sm font-medium transition-colors",
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
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
            {showDropdown && (searchResults?.length > 0 || isLoading) && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto">
                {isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Searching...
                  </div>
                ) : (
                  <div className="py-2">
                    {searchResults?.map((result: SearchResult, index: number) => (
                      <button
                        key={`mobile-${result.resultType}-${result.id}`}
                        onClick={() => handleResultClick(result)}
                        data-testid={`search-result-mobile-${result.resultType}-${index}`}
                        className="w-full px-4 py-3 text-left hover:bg-muted flex items-center space-x-3"
                      >
                        <div className="w-8 h-8 bg-muted rounded flex items-center justify-center">
                          {result.resultType === 'show' ? (
                            <Tv className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <Film className="w-4 h-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">
                            {result.resultType === 'episode' ? formatEpisodeTitle(result) : result.name}
                          </div>
                          {result.resultType === 'episode' && result.show && (
                            <div className="text-xs text-muted-foreground truncate">
                              {result.show.name}
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground">
                            {result.resultType === 'show' ? 'TV Show' : 'Episode'}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          
          {/* Mobile Tab Navigation */}
          <div className="flex space-x-1 mt-4 overflow-x-auto">
            {tabs.map((tab) => (
              <Link 
                key={tab.id}
                href={tab.href}
                data-testid={`button-tab-${tab.id}-mobile`}
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap",
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
