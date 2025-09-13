import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserEpisode, Episode, Show } from "@shared/schema";
import Header from "@/components/header";
import EpisodeCard from "@/components/episode-card";
import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, PlayCircle, Clock, Eye, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Episode queries
  const { data: untriagedEpisodes, isLoading: untriagedLoading } = useQuery({
    queryKey: ["/api/user/episodes", "untriaged"],
    queryFn: async () => {
      const response = await fetch("/api/user/episodes?status=untriaged");
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  const { data: nextEpisodes, isLoading: nextLoading } = useQuery({
    queryKey: ["/api/user/episodes", "next"],
    queryFn: async () => {
      const response = await fetch("/api/user/episodes?status=next");
      if (!response.ok) throw new Error("Failed to fetch next episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  const { data: laterEpisodes, isLoading: laterLoading } = useQuery({
    queryKey: ["/api/user/episodes", "later"],
    queryFn: async () => {
      const response = await fetch("/api/user/episodes?status=later");
      if (!response.ok) throw new Error("Failed to fetch later episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  const { data: watchedEpisodes, isLoading: watchedLoading } = useQuery({
    queryKey: ["/api/user/episodes", "watched"],
    queryFn: async () => {
      const response = await fetch("/api/user/episodes?status=watched");
      if (!response.ok) throw new Error("Failed to fetch watched episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
  });

  // Episode import mutation
  const importEpisodesMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/episodes/import", {});
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      toast({
        title: "Episodes imported",
        description: `Successfully imported ${data.imported} episodes (${data.skipped} skipped)`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Import failed",
        description: error.message || "Failed to import episodes",
        variant: "destructive",
      });
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
        untriaged: queryClient.getQueryData(["/api/user/episodes", "untriaged"]),
        next: queryClient.getQueryData(["/api/user/episodes", "next"]),
        later: queryClient.getQueryData(["/api/user/episodes", "later"]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched"]),
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
            queryClient.setQueryData(["/api/user/episodes", currentStatus], updatedCurrentData);
            
            // Add to new status cache with updated status and timestamps
            const updatedEpisode = {
              ...episode,
              status,
              triagedAt: new Date().toISOString(),
              ...(status === "watched" && { watchedAt: new Date().toISOString() })
            };
            
            const newStatusData = queryClient.getQueryData(["/api/user/episodes", status]) as any[] || [];
            queryClient.setQueryData(["/api/user/episodes", status], [...newStatusData, updatedEpisode]);
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
          queryClient.setQueryData(["/api/user/episodes", status], data);
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

  const handleImportEpisodes = () => {
    importEpisodesMutation.mutate();
  };

  // Sync scrobbles mutation
  const syncScrobblesMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/episodes/sync-scrobbles", {});
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      toast({
        title: "Scrobble sync completed",
        description: `${data.updated} episodes updated from TVMaze scrobbles`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Sync failed",
        description: error.message || "Failed to sync TVMaze scrobbles",
        variant: "destructive",
      });
    },
  });

  const handleSyncScrobbles = () => {
    syncScrobblesMutation.mutate();
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">
          {/* Import Episodes Button */}
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-foreground">Episode Triage</h1>
              <p className="text-muted-foreground mt-1">Manage your episode viewing queue</p>
            </div>
            <div className="flex space-x-2">
              <Button 
                onClick={handleImportEpisodes}
                disabled={importEpisodesMutation.isPending}
                data-testid="button-import-episodes"
              >
                <Download className="w-4 h-4 mr-2" />
                {importEpisodesMutation.isPending ? "Importing..." : "Import Episodes"}
              </Button>
              <Button 
                onClick={handleSyncScrobbles}
                disabled={syncScrobblesMutation.isPending}
                variant="outline"
                data-testid="button-sync-scrobbles"
              >
                <PlayCircle className="w-4 h-4 mr-2" />
                {syncScrobblesMutation.isPending ? "Syncing..." : "Sync Watched"}
              </Button>
            </div>
          </div>

          {/* New in Feed Section */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-2xl font-bold" data-testid="text-section-title-new-feed">New in Feed</h2>
                <span className="bg-yellow-500 text-white px-2 py-1 rounded-full text-xs font-bold" data-testid="text-new-feed-count">
                  {untriagedEpisodes?.length || 0}
                </span>
              </div>
              <p className="text-muted-foreground text-sm">Episodes that need your attention</p>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {untriagedLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                    <div className="flex space-x-3 mb-4">
                      <div className="w-20 h-14 bg-muted rounded-md"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-muted rounded"></div>
                        <div className="h-3 bg-muted rounded w-3/4"></div>
                        <div className="h-3 bg-muted rounded w-1/2"></div>
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      <div className="h-8 bg-muted rounded w-20"></div>
                      <div className="flex-1 h-8 bg-muted rounded"></div>
                      <div className="flex-1 h-8 bg-muted rounded"></div>
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
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                  <PlayCircle className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-2xl font-bold" data-testid="text-section-title-next">Next to Watch</h2>
                <span className="bg-green-500 text-white px-2 py-1 rounded-full text-xs font-bold" data-testid="text-next-count">
                  {nextEpisodes?.length || 0}
                </span>
              </div>
              <p className="text-muted-foreground text-sm">Your priority viewing queue</p>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {nextLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="bg-card rounded-lg p-4 animate-pulse border-l-4 border-green-500">
                    <div className="flex space-x-3 mb-4">
                      <div className="w-16 h-12 bg-muted rounded-md"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-muted rounded"></div>
                        <div className="h-3 bg-muted rounded w-3/4"></div>
                        <div className="h-3 bg-muted rounded w-1/2"></div>
                      </div>
                    </div>
                    <div className="flex justify-between">
                      <div className="h-6 bg-muted rounded w-16"></div>
                      <div className="flex space-x-1">
                        <div className="h-8 bg-muted rounded w-20"></div>
                        <div className="h-8 bg-muted rounded w-16"></div>
                      </div>
                    </div>
                  </div>
                ))
              ) : nextEpisodes && nextEpisodes.length > 0 ? (
                nextEpisodes
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
                      variant="priority"
                    />
                  ))
              ) : (
                <div className="col-span-full text-center py-8">
                  <PlayCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">No episodes queued</h3>
                  <p className="text-muted-foreground">Mark episodes as "Next" to build your viewing queue</p>
                </div>
              )}
            </div>
          </section>

          {/* Watch Later Section */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                  <Clock className="w-4 h-4 text-white" />
                </div>
                <h2 className="text-2xl font-bold" data-testid="text-section-title-later">Watch Later</h2>
                <span className="bg-blue-500 text-white px-2 py-1 rounded-full text-xs font-bold" data-testid="text-later-count">
                  {laterEpisodes?.length || 0}
                </span>
              </div>
              <p className="text-muted-foreground text-sm">Episodes saved for later</p>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
              {laterLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="bg-card rounded-lg p-3 animate-pulse">
                    <div className="flex space-x-2 mb-2">
                      <div className="w-12 h-8 bg-muted rounded-md"></div>
                      <div className="flex-1 space-y-1">
                        <div className="h-3 bg-muted rounded"></div>
                        <div className="h-2 bg-muted rounded w-2/3"></div>
                      </div>
                    </div>
                    <div className="h-5 bg-muted rounded w-16"></div>
                  </div>
                ))
              ) : laterEpisodes && laterEpisodes.length > 0 ? (
                laterEpisodes.map((userEpisode) => (
                  <EpisodeCard
                    key={userEpisode.id}
                    userEpisode={userEpisode}
                    onStatusChange={handleEpisodeStatusChange}
                    variant="compact"
                  />
                ))
              ) : (
                <div className="col-span-full text-center py-8">
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