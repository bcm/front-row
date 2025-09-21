import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserEpisode, Episode, Show } from "@shared/schema";
import Header from "@/components/header";
import EpisodeCard from "@/components/episode-card";
import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { PlayCircle, Clock, Eye, Users, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export default function Dashboard() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showMode, setShowMode] = useState<"personal" | "shared">("personal");
  const [expandedNextSeasons, setExpandedNextSeasons] = useState<Record<string, Set<number>>>({});
  const [expandedLaterSeasons, setExpandedLaterSeasons] = useState<Record<string, Set<number>>>({});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Episode queries
  const { data: nextEpisodes, isLoading: nextLoading } = useQuery({
    queryKey: ["/api/user/episodes", "next", showMode],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=next&showMode=${showMode}`);
      if (!response.ok) throw new Error("Failed to fetch next episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  const { data: laterEpisodes, isLoading: laterLoading } = useQuery({
    queryKey: ["/api/user/episodes", "later", showMode],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=later&showMode=${showMode}`);
      if (!response.ok) throw new Error("Failed to fetch later episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  const { data: watchedEpisodes, isLoading: watchedLoading } = useQuery({
    queryKey: ["/api/user/episodes", "watched", showMode],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=watched&showMode=${showMode}`);
      if (!response.ok) throw new Error("Failed to fetch watched episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  // Helper functions for seasonal grouping
  const groupNextEpisodesByShowAndSeason = useMemo(() => {
    if (!nextEpisodes) return {};
    
    const grouped: Record<string, {
      show: Show;
      seasons: Record<number, (UserEpisode & { episode: Episode & { show: Show } })[]>;
      earliestSeason: number;
      allSeasons: number[];
    }> = {};

    // Group episodes by show, then by season
    nextEpisodes.forEach(userEpisode => {
      const { show } = userEpisode.episode;
      const season = userEpisode.episode.season || 1;
      
      if (!grouped[show.id]) {
        grouped[show.id] = {
          show,
          seasons: {},
          earliestSeason: season,
          allSeasons: []
        };
      }
      
      if (!grouped[show.id].seasons[season]) {
        grouped[show.id].seasons[season] = [];
      }
      
      grouped[show.id].seasons[season].push(userEpisode);
      
      // Update earliest season
      if (season < grouped[show.id].earliestSeason) {
        grouped[show.id].earliestSeason = season;
      }
    });

    // Sort episodes within each season and collect all seasons
    Object.values(grouped).forEach(showData => {
      showData.allSeasons = Object.keys(showData.seasons)
        .map(Number)
        .sort((a, b) => a - b); // Sort ascending (earliest first)
      
      Object.values(showData.seasons).forEach(seasonEpisodes => {
        seasonEpisodes.sort((a, b) => {
          const episodeA = a.episode.number || 0;
          const episodeB = b.episode.number || 0;
          return episodeA - episodeB;
        });
      });
    });

    return grouped;
  }, [nextEpisodes]);

  const groupLaterEpisodesByShowAndSeason = useMemo(() => {
    if (!laterEpisodes) return {};
    
    const grouped: Record<string, {
      show: Show;
      seasons: Record<number, (UserEpisode & { episode: Episode & { show: Show } })[]>;
      earliestSeason: number;
      allSeasons: number[];
    }> = {};

    // Group episodes by show, then by season
    laterEpisodes.forEach(userEpisode => {
      const { show } = userEpisode.episode;
      const season = userEpisode.episode.season || 1;
      
      if (!grouped[show.id]) {
        grouped[show.id] = {
          show,
          seasons: {},
          earliestSeason: season,
          allSeasons: []
        };
      }
      
      if (!grouped[show.id].seasons[season]) {
        grouped[show.id].seasons[season] = [];
      }
      
      grouped[show.id].seasons[season].push(userEpisode);
      
      // Update earliest season
      if (season < grouped[show.id].earliestSeason) {
        grouped[show.id].earliestSeason = season;
      }
    });

    // Sort episodes within each season and collect all seasons
    Object.values(grouped).forEach(showData => {
      showData.allSeasons = Object.keys(showData.seasons)
        .map(Number)
        .sort((a, b) => a - b); // Sort ascending (earliest first)
      
      Object.values(showData.seasons).forEach(seasonEpisodes => {
        seasonEpisodes.sort((a, b) => {
          const episodeA = a.episode.number || 0;
          const episodeB = b.episode.number || 0;
          return episodeA - episodeB;
        });
      });
    });

    return grouped;
  }, [laterEpisodes]);

  const getVisibleSeasonsForNextShow = (showId: string, showData: any) => {
    const expandedForShow = expandedNextSeasons[showId] || new Set();
    const { earliestSeason, allSeasons } = showData;
    
    // Always include the earliest season + any expanded seasons
    const visibleSeasons = new Set([earliestSeason]);
    Array.from(expandedForShow).forEach((season: number) => visibleSeasons.add(season));
    
    // Return sorted array (earliest first)
    return allSeasons.filter((season: number) => visibleSeasons.has(season));
  };

  const getVisibleSeasonsForLaterShow = (showId: string, showData: any) => {
    const expandedForShow = expandedLaterSeasons[showId] || new Set();
    const { earliestSeason, allSeasons } = showData;
    
    // Always include the earliest season + any expanded seasons
    const visibleSeasons = new Set([earliestSeason]);
    Array.from(expandedForShow).forEach((season: number) => visibleSeasons.add(season));
    
    // Return sorted array (earliest first)
    return allSeasons.filter((season: number) => visibleSeasons.has(season));
  };

  const loadNextSeason = (showId: string, currentVisibleSeasons: number[], allSeasons: number[], isNext: boolean = true) => {
    // Find the next newer season to load
    const newestVisible = Math.max(...currentVisibleSeasons);
    const nextNewerSeason = allSeasons.find(season => season > newestVisible);
    
    if (nextNewerSeason) {
      const setExpandedFunction = isNext ? setExpandedNextSeasons : setExpandedLaterSeasons;
      const currentExpanded = isNext ? expandedNextSeasons : expandedLaterSeasons;
      
      setExpandedFunction(prev => ({
        ...prev,
        [showId]: new Set([...Array.from(currentExpanded[showId] || []), nextNewerSeason])
      }));
    }
  };

  // Episode update mutation with optimistic updates
  const updateEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      // Snapshot the previous values for rollback
      const previousData = {
        next: queryClient.getQueryData(["/api/user/episodes", "next", showMode]),
        later: queryClient.getQueryData(["/api/user/episodes", "later", showMode]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched", showMode]),
      };

      let updatedEpisodeInfo = null;

      // Find the episode in query caches and update optimistically
      Object.entries(previousData).forEach(([currentStatus, data]: [string, any]) => {
        if (data && Array.isArray(data)) {
          const episodeIndex = data.findIndex((ep: any) => ep.episode.id === episodeId);
          if (episodeIndex !== -1) {
            const episode = data[episodeIndex];
            
            // Store episode info for toast notification
            updatedEpisodeInfo = {
              showName: episode.episode.show.name,
              season: episode.episode.season,
              number: episode.episode.number
            };
            
            // Remove from current status cache
            const updatedCurrentData = data.filter((_: any, index: number) => index !== episodeIndex);
            queryClient.setQueryData(["/api/user/episodes", currentStatus, showMode], updatedCurrentData);
            
            // Add to new status cache with updated status and timestamps
            const updatedEpisode = {
              ...episode,
              status,
              triagedAt: new Date().toISOString(),
              ...(status === "watched" && { watchedAt: new Date().toISOString() })
            };
            
            const newStatusData = queryClient.getQueryData(["/api/user/episodes", status, showMode]) as any[] || [];
            queryClient.setQueryData(["/api/user/episodes", status, showMode], [...newStatusData, updatedEpisode]);
          }
        }
      });

      // Return a context object with the snapshotted value and episode info
      return { previousData, episodeInfo: updatedEpisodeInfo, episodeId };
    },
    onError: (error, variables, context) => {
      // Rollback changes
      if (context?.previousData) {
        Object.entries(context.previousData).forEach(([status, data]) => {
          queryClient.setQueryData(["/api/user/episodes", status, showMode], data);
        });
      }
      
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data, variables, context) => {
      // Skip query invalidation for faster processing - rely on optimistic updates
      // Queries will be refreshed when user navigates or manually refreshes
      
      // Create informative toast message with show name and episode number
      let toastTitle = "Episode updated";
      if (context?.episodeInfo) {
        const { showName, season, number } = context.episodeInfo;
        toastTitle = `${showName} ${season}x${number}`;
      }
      
      toast({
        title: toastTitle,
        description: "Episode status has been updated.",
      });
    },
  });

  const handleEpisodeStatusChange = (episodeId: number, status: string) => {
    updateEpisodeMutation.mutate({ episodeId, status });
  };

  // Track toggle loading state
  const [isToggling, setIsToggling] = useState(false);

  const handleToggleShowMode = async (newMode: string) => {
    if (isToggling || !newMode || newMode === showMode) return; // Prevent multiple toggles and same mode
    
    const validMode = newMode as "personal" | "shared";
    const previousMode = showMode;
    
    // Optimistically update the UI immediately
    setShowMode(validMode);
    setIsToggling(true);
    
    // Prefetch data for the target mode in background
    try {
      await Promise.all([
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "next", validMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=next&showMode=${validMode}`);
            if (!response.ok) throw new Error("Failed to fetch next episodes");
            return response.json();
          },
        }),
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "later", validMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=later&showMode=${validMode}`);
            if (!response.ok) throw new Error("Failed to fetch later episodes");
            return response.json();
          },
        }),
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "watched", validMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=watched&showMode=${validMode}`);
            if (!response.ok) throw new Error("Failed to fetch watched episodes");
            return response.json();
          },
        }),
      ]);
      
      toast({
        title: "View updated",
        description: `Now showing ${validMode} shows`,
      });
    } catch (error) {
      // Revert the optimistic update on error
      setShowMode(previousMode);
      
      toast({
        title: "Toggle failed",
        description: "Failed to switch view mode. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">

          {/* Show Mode Toggle */}
          <div className="flex items-center space-x-3 p-4 bg-card rounded-lg border">
            <Users className="w-5 h-5 text-muted-foreground" />
            <Label className="text-sm font-medium">
              Show Mode
            </Label>
            <ToggleGroup
              type="single"
              value={showMode}
              onValueChange={handleToggleShowMode}
              disabled={isToggling}
              data-testid="toggle-show-mode"
              className="ml-auto"
            >
              <ToggleGroupItem value="personal" aria-label="Personal shows">
                Personal
              </ToggleGroupItem>
              <ToggleGroupItem value="shared" aria-label="Shared shows">
                Shared
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Next to Watch Section */}
          <section>
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                <PlayCircle className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-2xl font-bold" data-testid="text-section-title-next">Next to Watch</h2>
              <p className="text-muted-foreground text-base ml-4">Your priority viewing queue</p>
            </div>
            
            <div className="space-y-6">
              {nextLoading ? (
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="w-full sm:w-32 h-48 sm:h-24 bg-muted rounded-md flex-shrink-0"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-4 bg-muted rounded"></div>
                          <div className="h-3 bg-muted rounded w-3/4"></div>
                          <div className="h-3 bg-muted rounded w-1/2"></div>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-shrink-0">
                          <div className="space-y-1">
                            <div className="h-4 bg-muted rounded w-24"></div>
                            <div className="h-4 bg-muted rounded w-20"></div>
                          </div>
                          <div className="flex gap-2">
                            <div className="h-8 bg-muted rounded w-20"></div>
                            <div className="h-8 bg-muted rounded w-16"></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : Object.keys(groupNextEpisodesByShowAndSeason).length > 0 ? (
                Object.entries(groupNextEpisodesByShowAndSeason)
                  .sort(([, a], [, b]) => a.show.name.localeCompare(b.show.name))
                  .map(([showId, showData]) => {
                    const visibleSeasons = getVisibleSeasonsForNextShow(showId, showData);
                    
                    return (
                      <div key={showId} className="space-y-4">
                        {/* Show Title */}
                        <Link href={`/show/${showId}`}>
                          <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2 hover:text-primary transition-colors cursor-pointer">
                            {showData.show.name}
                          </h3>
                        </Link>
                        
                        {/* Seasons */}
                        <div className="space-y-6">
                          {visibleSeasons.map((season: number) => {
                            const seasonEpisodes = showData.seasons[season] || [];
                            
                            return (
                              <div key={season} className="space-y-3">
                                {/* Season Header */}
                                <div className="flex items-center justify-between">
                                  <h4 className="text-md font-medium text-muted-foreground">
                                    Season {season}
                                  </h4>
                                  <div className="text-sm text-muted-foreground">
                                    {seasonEpisodes.length} episode{seasonEpisodes.length !== 1 ? 's' : ''}
                                  </div>
                                </div>
                                
                                {/* Episodes */}
                                <div className="space-y-3">
                                  {seasonEpisodes.map((userEpisode) => (
                                    <EpisodeCard
                                      key={userEpisode.id}
                                      userEpisode={userEpisode}
                                      onStatusChange={handleEpisodeStatusChange}
                                      variant="wide"
                                    />
                                  ))}
                                </div>
                                
                                {/* Load Next Season Button */}
                                {season === Math.max(...visibleSeasons) && 
                                 showData.allSeasons.some(s => s > season) && (() => {
                                   const nextNewerSeason = showData.allSeasons.find(s => s > season);
                                   return (
                                     <div className="flex justify-center pt-2">
                                       <Button 
                                         variant="outline" 
                                         size="sm"
                                         onClick={() => loadNextSeason(showId, visibleSeasons, showData.allSeasons, true)}
                                         data-testid={`button-load-next-season-${showId}`}
                                         className="text-muted-foreground hover:text-foreground"
                                       >
                                         <ChevronDown className="w-4 h-4 mr-2" />
                                         Load Season {nextNewerSeason}
                                       </Button>
                                     </div>
                                   );
                                 })()}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
              ) : (
                <div className="text-center py-8">
                  <PlayCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">No episodes queued</h3>
                  <p className="text-muted-foreground">Mark episodes as "Next" to build your viewing queue</p>
                </div>
              )}
            </div>
          </section>

          {/* Watch Later Section */}
          <section>
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                <Clock className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-2xl font-bold" data-testid="text-section-title-later">Watch Later</h2>
              <p className="text-muted-foreground text-base ml-4">Episodes saved for later</p>
            </div>
            
            <div className="space-y-6">
              {laterLoading ? (
                <div className="space-y-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="w-full sm:w-32 h-48 sm:h-24 bg-muted rounded-md flex-shrink-0"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-4 bg-muted rounded"></div>
                          <div className="h-3 bg-muted rounded w-3/4"></div>
                          <div className="h-3 bg-muted rounded w-1/2"></div>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-shrink-0">
                          <div className="space-y-1">
                            <div className="h-4 bg-muted rounded w-24"></div>
                            <div className="h-4 bg-muted rounded w-20"></div>
                          </div>
                          <div className="flex gap-2">
                            <div className="h-8 bg-muted rounded w-20"></div>
                            <div className="h-8 bg-muted rounded w-16"></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : Object.keys(groupLaterEpisodesByShowAndSeason).length > 0 ? (
                Object.entries(groupLaterEpisodesByShowAndSeason)
                  .sort(([, a], [, b]) => a.show.name.localeCompare(b.show.name))
                  .map(([showId, showData]) => {
                    const visibleSeasons = getVisibleSeasonsForLaterShow(showId, showData);
                    
                    return (
                      <div key={showId} className="space-y-4">
                        {/* Show Title */}
                        <Link href={`/show/${showId}`}>
                          <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2 hover:text-primary transition-colors cursor-pointer">
                            {showData.show.name}
                          </h3>
                        </Link>
                        
                        {/* Seasons */}
                        <div className="space-y-6">
                          {visibleSeasons.map((season: number) => {
                            const seasonEpisodes = showData.seasons[season] || [];
                            
                            return (
                              <div key={season} className="space-y-3">
                                {/* Season Header */}
                                <div className="flex items-center justify-between">
                                  <h4 className="text-md font-medium text-muted-foreground">
                                    Season {season}
                                  </h4>
                                  <div className="text-sm text-muted-foreground">
                                    {seasonEpisodes.length} episode{seasonEpisodes.length !== 1 ? 's' : ''}
                                  </div>
                                </div>
                                
                                {/* Episodes */}
                                <div className="space-y-3">
                                  {seasonEpisodes.map((userEpisode) => (
                                    <EpisodeCard
                                      key={userEpisode.id}
                                      userEpisode={userEpisode}
                                      onStatusChange={handleEpisodeStatusChange}
                                      variant="wide"
                                    />
                                  ))}
                                </div>
                                
                                {/* Load Next Season Button */}
                                {season === Math.max(...visibleSeasons) && 
                                 showData.allSeasons.some(s => s > season) && (() => {
                                   const nextNewerSeason = showData.allSeasons.find(s => s > season);
                                   return (
                                     <div className="flex justify-center pt-2">
                                       <Button 
                                         variant="outline" 
                                         size="sm"
                                         onClick={() => loadNextSeason(showId, visibleSeasons, showData.allSeasons, false)}
                                         data-testid={`button-load-next-season-later-${showId}`}
                                         className="text-muted-foreground hover:text-foreground"
                                       >
                                         <ChevronDown className="w-4 h-4 mr-2" />
                                         Load Season {nextNewerSeason}
                                       </Button>
                                     </div>
                                   );
                                 })()}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
              ) : (
                <div className="text-center py-8">
                  <Clock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">No episodes for later</h3>
                  <p className="text-muted-foreground">Episodes you mark as "Later" will appear here</p>
                </div>
              )}
            </div>
          </section>

        </div>
      </main>

      <FloatingAddButton onClick={() => setShowAddDialog(true)} />
      
      <AddShowDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
      />
    </div>
  );
}