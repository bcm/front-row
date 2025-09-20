import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserEpisode, Episode, Show } from "@shared/schema";
import Header from "@/components/header";
import EpisodeCard from "@/components/episode-card";
import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { AlertTriangle, PlayCircle, Clock, Eye, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";

export default function Dashboard() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showMode, setShowMode] = useState<"personal" | "shared">("personal");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Episode queries
  const { data: untriagedEpisodes, isLoading: untriagedLoading } = useQuery({
    queryKey: ["/api/user/episodes", "untriaged", showMode],
    queryFn: async () => {
      const response = await fetch(`/api/user/episodes?status=untriaged&showMode=${showMode}`);
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

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
        untriaged: queryClient.getQueryData(["/api/user/episodes", "untriaged", showMode]),
        next: queryClient.getQueryData(["/api/user/episodes", "next", showMode]),
        later: queryClient.getQueryData(["/api/user/episodes", "later", showMode]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched", showMode]),
      };

      let updatedEpisodeInfo = null;

      // Find the episode in all query caches and update optimistically
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
      return { previousData, episodeInfo: updatedEpisodeInfo };
    },
    onError: (err, variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
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
      // Invalidate queries to ensure we have the latest data from server
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      
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

  const handleToggleShowMode = async () => {
    if (isToggling) return; // Prevent multiple toggles
    
    const newMode = showMode === "personal" ? "shared" : "personal";
    setIsToggling(true);
    
    // Prefetch data for the target mode first to ensure smooth transition
    try {
      await Promise.all([
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "untriaged", newMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=untriaged&showMode=${newMode}`);
            if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
            return response.json();
          },
        }),
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "next", newMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=next&showMode=${newMode}`);
            if (!response.ok) throw new Error("Failed to fetch next episodes");
            return response.json();
          },
        }),
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "later", newMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=later&showMode=${newMode}`);
            if (!response.ok) throw new Error("Failed to fetch later episodes");
            return response.json();
          },
        }),
        queryClient.prefetchQuery({
          queryKey: ["/api/user/episodes", "watched", newMode],
          queryFn: async () => {
            const response = await fetch(`/api/user/episodes?status=watched&showMode=${newMode}`);
            if (!response.ok) throw new Error("Failed to fetch watched episodes");
            return response.json();
          },
        }),
      ]);
      
      // Now switch the mode optimistically since data is ready
      setShowMode(newMode);
      
      toast({
        title: "View updated",
        description: `Now showing ${newMode} shows`,
      });
    } catch (error) {
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
            <Label htmlFor="show-mode-toggle" className="text-sm font-medium">
              Show shared shows
            </Label>
            <Switch
              id="show-mode-toggle"
              checked={showMode === "shared"}
              onCheckedChange={handleToggleShowMode}
              disabled={isToggling}
              data-testid="toggle-show-mode"
            />
            <p className="text-sm font-medium ml-auto">
              {showMode === "shared" ? "Shared" : "Personal"}
            </p>
          </div>

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
              ) : untriagedEpisodes && untriagedEpisodes.length > 0 ? (
                untriagedEpisodes
                  .sort((a, b) => {
                    // First sort by show name alphabetically
                    const showComparison = a.episode.show.name.localeCompare(b.episode.show.name);
                    if (showComparison !== 0) return showComparison;
                    
                    // Then sort by season number
                    const seasonA = a.episode.season || 0;
                    const seasonB = b.episode.season || 0;
                    if (seasonA !== seasonB) return seasonA - seasonB;
                    
                    // Finally sort by episode number
                    const episodeA = a.episode.number || 0;
                    const episodeB = b.episode.number || 0;
                    return episodeA - episodeB;
                  })
                  .map((userEpisode) => (
                    <EpisodeCard
                      key={userEpisode.id}
                      userEpisode={userEpisode}
                      onStatusChange={handleEpisodeStatusChange}
                      variant="wide"
                    />
                  ))
              ) : (
                <div className="col-span-full text-center py-8">
                  <AlertTriangle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">No new episodes</h3>
                  <p className="text-muted-foreground">New episodes will appear here for triage</p>
                </div>
              )}
            </div>
          </section>

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
              ) : nextEpisodes && nextEpisodes.length > 0 ? (
                Object.entries(
                  nextEpisodes.reduce((acc, userEpisode) => {
                    const showName = userEpisode.episode.show.name;
                    if (!acc[showName]) {
                      acc[showName] = [];
                    }
                    acc[showName].push(userEpisode);
                    return acc;
                  }, {} as Record<string, typeof nextEpisodes>)
                )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([showName, showEpisodes]) => (
                  <div key={showName} className="space-y-3">
                    <Link href={`/show/${showEpisodes[0].episode.show.id}`}>
                      <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2 hover:text-primary transition-colors cursor-pointer">
                        {showName}
                      </h3>
                    </Link>
                    <div className="space-y-4">
                      {showEpisodes
                        .sort((a, b) => {
                          // Sort by season number first
                          const seasonA = a.episode.season || 0;
                          const seasonB = b.episode.season || 0;
                          if (seasonA !== seasonB) return seasonA - seasonB;
                          
                          // Then by episode number within the season
                          const episodeA = a.episode.number || 0;
                          const episodeB = b.episode.number || 0;
                          return episodeA - episodeB;
                        })
                        .map((userEpisode) => (
                          <EpisodeCard
                            key={userEpisode.id}
                            userEpisode={userEpisode}
                            onStatusChange={handleEpisodeStatusChange}
                            variant="wide"
                          />
                        ))}
                    </div>
                  </div>
                ))
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
              ) : laterEpisodes && laterEpisodes.length > 0 ? (
                Object.entries(
                  laterEpisodes.reduce((acc, userEpisode) => {
                    const showName = userEpisode.episode.show.name;
                    if (!acc[showName]) {
                      acc[showName] = [];
                    }
                    acc[showName].push(userEpisode);
                    return acc;
                  }, {} as Record<string, typeof laterEpisodes>)
                )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([showName, showEpisodes]) => (
                  <div key={showName} className="space-y-3">
                    <Link href={`/show/${showEpisodes[0].episode.show.id}`}>
                      <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2 hover:text-primary transition-colors cursor-pointer">
                        {showName}
                      </h3>
                    </Link>
                    <div className="space-y-4">
                      {showEpisodes
                        .sort((a, b) => {
                          // Sort by season number
                          const seasonA = a.episode.season || 0;
                          const seasonB = b.episode.season || 0;
                          if (seasonA !== seasonB) return seasonA - seasonB;
                          
                          // Then sort by episode number
                          const episodeA = a.episode.number || 0;
                          const episodeB = b.episode.number || 0;
                          return episodeA - episodeB;
                        })
                        .map((userEpisode) => (
                          <EpisodeCard
                            key={userEpisode.id}
                            userEpisode={userEpisode}
                            onStatusChange={handleEpisodeStatusChange}
                            variant="wide"
                          />
                        ))}
                    </div>
                  </div>
                ))
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