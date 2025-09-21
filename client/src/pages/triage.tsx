import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserEpisode, Episode, Show } from "@shared/schema";
import Header from "@/components/header";
import EpisodeCard from "@/components/episode-card";
import { AlertTriangle, PlayCircle, Clock, Eye, Users, ChevronDown, Play, RotateCcw, SkipForward, ArrowDown, Share, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";

export default function Triage() {
  const [hiddenEpisodes, setHiddenEpisodes] = useState<Set<number>>(new Set());
  const [expandedSeasons, setExpandedSeasons] = useState<Record<string, Set<number>>>({});
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Episode queries
  const { data: untriagedEpisodes, isLoading: untriagedLoading } = useQuery({
    queryKey: ["/api/user/episodes", "untriaged"],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=untriaged`);
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  // User shows query to get sharing status
  const { data: userShows } = useQuery({
    queryKey: ["/api/user/shows"],
    queryFn: async () => {
      const response = await fetch("/api/user/shows");
      if (!response.ok) throw new Error("Failed to fetch user shows");
      return response.json() as Promise<{id: string; showId: number; isShared: boolean; addedAt: string}[]>;
    },
  });

  const groupEpisodesByShowAndSeason = useMemo(() => {
    if (!untriagedEpisodes) return {};
    
    const filteredEpisodes = untriagedEpisodes.filter(userEpisode => 
      !hiddenEpisodes.has(userEpisode.episode.id) && 
      userEpisode.episode.airdate // Exclude episodes without air dates (future unscheduled episodes)
    );
    
    const grouped: Record<string, {
      show: Show;
      seasons: Record<number, (UserEpisode & { episode: Episode & { show: Show } })[]>;
      mostRecentSeason: number;
      allSeasons: number[];
    }> = {};

    // Group episodes by show, then by season
    filteredEpisodes.forEach(userEpisode => {
      const { show } = userEpisode.episode;
      const season = userEpisode.episode.season || 1;
      
      if (!grouped[show.id]) {
        grouped[show.id] = {
          show,
          seasons: {},
          mostRecentSeason: season,
          allSeasons: []
        };
      }
      
      if (!grouped[show.id].seasons[season]) {
        grouped[show.id].seasons[season] = [];
      }
      
      grouped[show.id].seasons[season].push(userEpisode);
      
      // Update most recent season
      if (season > grouped[show.id].mostRecentSeason) {
        grouped[show.id].mostRecentSeason = season;
      }
    });

    // Sort episodes within each season and collect all seasons
    Object.values(grouped).forEach(showData => {
      showData.allSeasons = Object.keys(showData.seasons)
        .map(Number)
        .sort((a, b) => b - a); // Sort descending (most recent first)
      
      Object.values(showData.seasons).forEach(seasonEpisodes => {
        seasonEpisodes.sort((a, b) => {
          const episodeA = a.episode.number || 0;
          const episodeB = b.episode.number || 0;
          return episodeA - episodeB;
        });
      });
    });

    return grouped;
  }, [untriagedEpisodes, hiddenEpisodes]);

  const getVisibleSeasonsForShow = (showId: string, showData: any) => {
    const expandedForShow = expandedSeasons[showId] || new Set();
    const { mostRecentSeason, allSeasons } = showData;
    
    // Always include the most recent season + any expanded seasons
    const visibleSeasons = new Set([mostRecentSeason]);
    Array.from(expandedForShow).forEach((season: number) => visibleSeasons.add(season));
    
    // Return sorted array (most recent first)
    return allSeasons.filter((season: number) => visibleSeasons.has(season));
  };

  const loadEarlierSeason = (showId: string, currentVisibleSeasons: number[], allSeasons: number[]) => {
    // Find the next older season to load
    const oldestVisible = Math.min(...currentVisibleSeasons);
    const nextOlderSeason = allSeasons.find(season => season < oldestVisible);
    
    if (nextOlderSeason) {
      setExpandedSeasons(prev => ({
        ...prev,
        [showId]: new Set([...Array.from(prev[showId] || []), nextOlderSeason])
      }));
    }
  };

  const checkAutoProgression = (episodeId: number, showId: string) => {
    const showData = groupEpisodesByShowAndSeason[showId];
    if (!showData) return;

    const visibleSeasons = getVisibleSeasonsForShow(showId, showData);
    
    // Check if all episodes in current visible seasons are hidden
    const allVisibleEpisodesHidden = visibleSeasons.every((season: number) => {
      const seasonEpisodes = showData.seasons[season] || [];
      return seasonEpisodes.every(ep => 
        hiddenEpisodes.has(ep.episode.id) || !ep.episode.airdate
      );
    });

    if (allVisibleEpisodesHidden && showData.allSeasons.length > visibleSeasons.length) {
      // Load the next older season automatically
      const oldestVisible = Math.min(...visibleSeasons);
      const nextOlderSeason = showData.allSeasons.find(season => season < oldestVisible);
      
      if (nextOlderSeason) {
        setTimeout(() => {
          setExpandedSeasons(prev => ({
            ...prev,
            [showId]: new Set([...Array.from(prev[showId] || []), nextOlderSeason])
          }));
        }, 300);
      }
    }
  };

  const updateEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      // Snapshot the previous values for rollback (excluding untriaged since we use local state now)
      const previousData = {
        next: queryClient.getQueryData(["/api/user/episodes", "next", "personal"]),
        later: queryClient.getQueryData(["/api/user/episodes", "later", "personal"]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched", "personal"]),
      };

      let updatedEpisodeInfo = null;

      // Find the episode in query caches and update optimistically (skip untriaged, handled by local state)
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
            queryClient.setQueryData(["/api/user/episodes", currentStatus, "personal"], updatedCurrentData);
            
            // Add to new status cache with updated status and timestamps
            const updatedEpisode = {
              ...episode,
              status,
              triagedAt: new Date().toISOString(),
              ...(status === "watched" && { watchedAt: new Date().toISOString() })
            };
            
            const newStatusData = queryClient.getQueryData(["/api/user/episodes", status, "personal"]) as any[] || [];
            queryClient.setQueryData(["/api/user/episodes", status, "personal"], [...newStatusData, updatedEpisode]);
          }
        }
      });

      // Also check untriaged episodes for episode info (but don't modify cache)
      if (!updatedEpisodeInfo) {
        const untriagedData = queryClient.getQueryData(["/api/user/episodes", "untriaged"]) as any[];
        if (untriagedData) {
          const episode = untriagedData.find((ep: any) => ep.episode.id === episodeId);
          if (episode) {
            updatedEpisodeInfo = {
              showName: episode.episode.show.name,
              season: episode.episode.season,
              number: episode.episode.number
            };
          }
        }
      }

      return { episodeId, episodeInfo: updatedEpisodeInfo, previousData };
    },
    onError: (error, variables, context) => {
      // Rollback changes
      if (context?.previousData) {
        Object.entries(context.previousData).forEach(([status, data]) => {
          queryClient.setQueryData(["/api/user/episodes", status, "personal"], data);
        });
      }
      
      // Also remove the episode from hiddenEpisodes on error to show it again
      if (context?.episodeId) {
        setHiddenEpisodes(prev => {
          const newSet = new Set(prev);
          newSet.delete(context.episodeId);
          return newSet;
        });
      }
      
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data, variables, context) => {
      // Invalidate queries to ensure all views refresh properly
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"], exact: false });
      
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

  // Update show sharing status mutation with optimistic updates
  const updateShowSharingMutation = useMutation({
    mutationFn: async ({ showId, isShared }: { showId: number; isShared: boolean }) => {
      return apiRequest("PATCH", `/api/user/shows/${showId}/shared`, { isShared });
    },
    onMutate: async ({ showId, isShared }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["/api/user/shows"] });
      
      // Snapshot the previous value for rollback
      const previousUserShows = queryClient.getQueryData(["/api/user/shows"]);
      
      // Optimistically update the userShows cache
      queryClient.setQueryData(["/api/user/shows"], (oldData: any) => {
        if (!oldData) return oldData;
        return oldData.map((userShow: any) => 
          userShow.showId === showId 
            ? { ...userShow, isShared }
            : userShow
        );
      });
      
      return { previousUserShows };
    },
    onSuccess: (data, variables) => {
      toast({
        title: "Show updated",
        description: `Show marked as ${variables.isShared ? 'shared' : 'personal'}`,
      });
    },
    onError: (error, variables, context) => {
      // Rollback the optimistic update
      if (context?.previousUserShows) {
        queryClient.setQueryData(["/api/user/shows"], context.previousUserShows);
      }
      
      toast({
        title: "Error",
        description: "Failed to update show sharing status",
        variant: "destructive",
      });
    },
  });

  // Bulk season status change mutation with optimistic updates
  const bulkSeasonStatusMutation = useMutation({
    mutationFn: async ({ episodesList, status }: { episodesList: any[], status: string }) => {
      // Send all episode updates in parallel
      const promises = episodesList.map(userEpisode => 
        apiRequest("PATCH", `/api/user/episodes/${userEpisode.episode.id}`, { status })
      );
      return Promise.all(promises);
    },
    onMutate: async ({ episodesList, status }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      // Snapshot the previous values for rollback
      const previousData = {
        next: queryClient.getQueryData(["/api/user/episodes", "next", "personal"]),
        later: queryClient.getQueryData(["/api/user/episodes", "later", "personal"]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched", "personal"]),
      };

      // Immediately hide episodes from untriaged view for fast UI response
      if (status !== "untriaged") {
        episodesList.forEach(userEpisode => {
          setHiddenEpisodes(prev => new Set(prev).add(userEpisode.episode.id));
        });
      }

      // Optimistically update query caches for each episode
      episodesList.forEach(userEpisode => {
        const episodeId = userEpisode.episode.id;
        
        // Remove from current status caches
        Object.entries(previousData).forEach(([currentStatus, data]: [string, any]) => {
          if (data && Array.isArray(data)) {
            const episodeIndex = data.findIndex((ep: any) => ep.episode.id === episodeId);
            if (episodeIndex !== -1) {
              const updatedCurrentData = data.filter((_: any, index: number) => index !== episodeIndex);
              queryClient.setQueryData(["/api/user/episodes", currentStatus, "personal"], updatedCurrentData);
              
              // Add to new status cache with updated status and timestamps
              const episode = data[episodeIndex];
              const updatedEpisode = {
                ...episode,
                status,
                triagedAt: new Date().toISOString(),
                ...(status === "watched" && { watchedAt: new Date().toISOString() })
              };
              
              const newStatusData = queryClient.getQueryData(["/api/user/episodes", status, "personal"]) as any[] || [];
              queryClient.setQueryData(["/api/user/episodes", status, "personal"], [...newStatusData, updatedEpisode]);
            }
          }
        });
      });

      return { 
        previousData,
        episodeIds: episodesList.map(ep => ep.episode.id),
        showName: episodesList[0]?.episode?.show?.name,
        season: episodesList[0]?.episode?.season
      };
    },
    onSuccess: (data, variables, context) => {
      // Invalidate queries to ensure all views refresh properly (nav badge, triage page, etc.)
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"], exact: false });
      
      if (context?.showName && context?.season) {
        toast({
          title: `${context.showName} Season ${context.season}`,
          description: `${variables.episodesList.length} episodes marked as ${variables.status}`,
        });
      }
    },
    onError: (error, variables, context) => {
      // Rollback optimistic updates
      if (context?.previousData) {
        Object.entries(context.previousData).forEach(([status, data]) => {
          queryClient.setQueryData(["/api/user/episodes", status, "personal"], data);
        });
      }
      
      // Restore hidden episodes
      if (context?.episodeIds) {
        setHiddenEpisodes(prev => {
          const newSet = new Set(prev);
          context.episodeIds.forEach((id: number) => newSet.delete(id));
          return newSet;
        });
      }
      
      toast({
        title: "Error",
        description: "Failed to update episodes. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Bulk season status change function
  const handleBulkSeasonStatusChange = (episodesList: any[], status: string) => {
    bulkSeasonStatusMutation.mutate({ episodesList, status });
  };

  const handleEpisodeStatusChange = (episodeId: number, status: string) => {
    // Find the show ID for auto-progression logic
    let showId = '';
    if (untriagedEpisodes) {
      const episode = untriagedEpisodes.find(ep => ep.episode.id === episodeId);
      showId = episode?.episode?.show?.id?.toString() || '';
    }

    // Hide the episode from the UI immediately for fast response
    if (status !== "untriaged") {
      setHiddenEpisodes(prev => new Set(prev).add(episodeId));

      // Check if we should auto-load the next season
      if (showId) {
        checkAutoProgression(episodeId, showId);
      }
    }

    updateEpisodeMutation.mutate({ episodeId, status });
  };

  // Helper function to get show sharing status
  const getShowSharingStatus = (showId: number): { isShared?: boolean; userShowId?: string } => {
    if (!userShows) return {};
    const userShow = userShows.find(us => us.showId === showId);
    return {
      isShared: userShow?.isShared,
      userShowId: userShow?.id
    };
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">

          {/* New in Feed Section */}
          <section>
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-2xl font-bold" data-testid="text-section-title-new-feed">New in Feed</h2>
              <p className="text-muted-foreground text-base ml-4">Episodes that need your attention</p>
            </div>
            
            <div className="space-y-4">
              {untriagedLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
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
                          <div className="h-8 bg-muted rounded w-20"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              ) : Object.keys(groupEpisodesByShowAndSeason).length > 0 ? (
                Object.entries(groupEpisodesByShowAndSeason)
                  .sort(([, a], [, b]) => a.show.name.localeCompare(b.show.name))
                  .map(([showId, showData]) => {
                    const visibleSeasons = getVisibleSeasonsForShow(showId, showData);
                    
                    // Check if this show has any visible episodes
                    const hasVisibleEpisodes = visibleSeasons.some((season: number) => {
                      const seasonEpisodes = showData.seasons[season] || [];
                      return seasonEpisodes.some(ep => !hiddenEpisodes.has(ep.episode.id) && ep.episode.airdate);
                    });
                    
                    if (!hasVisibleEpisodes) return null;
                    
                    const showSharingInfo = getShowSharingStatus(parseInt(showId));
                    
                    return (
                      <div key={showId} className="space-y-4">
                        {/* Show Title with Sharing Status */}
                        <div className="flex items-center justify-between border-b border-border pb-2">
                          <Link href={`/show/${showId}`}>
                            <h3 className="text-lg font-semibold text-foreground hover:text-primary transition-colors cursor-pointer">
                              {showData.show.name}
                            </h3>
                          </Link>
                          
                          {/* Sharing Status and Controls */}
                          <div className="flex items-center space-x-3">
                            {showSharingInfo.isShared !== undefined ? (
                              /* Current Status Badge Only */
                              <Badge 
                                variant={showSharingInfo.isShared ? "default" : "secondary"}
                                className="flex items-center space-x-1"
                              >
                                {showSharingInfo.isShared ? (
                                  <Share className="w-3 h-3" />
                                ) : (
                                  <User className="w-3 h-3" />
                                )}
                                <span>{showSharingInfo.isShared ? 'Shared' : 'Personal'}</span>
                              </Badge>
                            ) : (
                              <div className="flex items-center space-x-2">
                                <span className="text-xs text-muted-foreground">Set as:</span>
                                <Select
                                  onValueChange={(value) => {
                                    const isShared = value === 'shared';
                                    updateShowSharingMutation.mutate({
                                      showId: parseInt(showId),
                                      isShared
                                    });
                                  }}
                                  disabled={updateShowSharingMutation.isPending}
                                >
                                  <SelectTrigger className="w-auto h-8 text-xs">
                                    <SelectValue placeholder="Choose..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="personal">Personal</SelectItem>
                                    <SelectItem value="shared">Shared</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {/* Seasons */}
                        <div className="space-y-6">
                          {visibleSeasons.map((season: number) => {
                            const seasonEpisodes = showData.seasons[season] || [];
                            const visibleEpisodes = seasonEpisodes.filter(ep => !hiddenEpisodes.has(ep.episode.id) && ep.episode.airdate);
                            
                            if (visibleEpisodes.length === 0) return null;
                            
                            return (
                              <div key={season} className="space-y-3">
                                {/* Season Header */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center space-x-4">
                                    <h4 className="text-md font-medium text-muted-foreground">
                                      Season {season}
                                    </h4>
                                    <div className="text-sm text-muted-foreground">
                                      {visibleEpisodes.length} episode{visibleEpisodes.length !== 1 ? 's' : ''}
                                    </div>
                                  </div>
                                  
                                  {/* Bulk Action Buttons */}
                                  <div className="flex items-center space-x-1">
                                    <span className="text-xs text-muted-foreground mr-2">Mark all:</span>
                                    <Button 
                                      size="sm" 
                                      variant="outline"
                                      onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "next")}
                                      data-testid={`button-bulk-next-${showId}-${season}`}
                                      className="h-7 px-2 text-xs hover:bg-green-50 hover:text-green-700 hover:border-green-300"
                                      title="Mark season as Next"
                                    >
                                      <Play className="w-3 h-3 mr-1" />
                                      Next
                                    </Button>
                                    <Button 
                                      size="sm" 
                                      variant="outline"
                                      onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "later")}
                                      data-testid={`button-bulk-later-${showId}-${season}`}
                                      className="h-7 px-2 text-xs hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300"
                                      title="Mark season as Later"
                                    >
                                      <Clock className="w-3 h-3 mr-1" />
                                      Later
                                    </Button>
                                    <Button 
                                      size="sm" 
                                      variant="outline"
                                      onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "watched")}
                                      data-testid={`button-bulk-watched-${showId}-${season}`}
                                      className="h-7 px-2 text-xs hover:bg-purple-50 hover:text-purple-700 hover:border-purple-300"
                                      title="Mark season as Watched"
                                    >
                                      <Eye className="w-3 h-3 mr-1" />
                                      Watched
                                    </Button>
                                    <Button 
                                      size="sm" 
                                      variant="outline"
                                      onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "skipped")}
                                      data-testid={`button-bulk-skipped-${showId}-${season}`}
                                      className="h-7 px-2 text-xs hover:bg-red-50 hover:text-red-700 hover:border-red-300"
                                      title="Mark season as Skipped"
                                    >
                                      <SkipForward className="w-3 h-3 mr-1" />
                                      Skipped
                                    </Button>
                                  </div>
                                </div>
                                
                                {/* Episodes */}
                                <div className="space-y-3">
                                  {visibleEpisodes.map((userEpisode) => (
                                    <EpisodeCard
                                      key={userEpisode.id}
                                      userEpisode={userEpisode}
                                      onStatusChange={handleEpisodeStatusChange}
                                      variant="wide"
                                    />
                                  ))}
                                </div>
                                
                                {/* Load Earlier Season Button */}
                                {season === Math.min(...visibleSeasons) && 
                                 showData.allSeasons.some(s => s < season) && (() => {
                                   const nextOlderSeason = showData.allSeasons.find(s => s < season);
                                   return (
                                     <div className="flex justify-center pt-2">
                                       <Button 
                                         variant="outline" 
                                         size="sm"
                                         onClick={() => loadEarlierSeason(showId, visibleSeasons, showData.allSeasons)}
                                         data-testid={`button-load-earlier-season-${showId}`}
                                         className="text-muted-foreground hover:text-foreground"
                                       >
                                         <ChevronDown className="w-4 h-4 mr-2" />
                                         Load Season {nextOlderSeason}
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
                  .filter(Boolean)
              ) : (
                <div className="col-span-full text-center py-8">
                  <AlertTriangle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">No new episodes</h3>
                  <p className="text-muted-foreground">New episodes will appear here for triage</p>
                </div>
              )}
            </div>
          </section>

        </div>
      </main>
    </div>
  );
}