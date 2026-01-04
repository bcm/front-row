import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserEpisode, Episode, Show } from "@shared/schema";
import Header from "@/components/header";
import EpisodeCard from "@/components/episode-card";
import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { PlayCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import CountdownTimer from "@/components/countdown-timer";

export default function Dashboard() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // User settings query to get show mode
  const { data: userSettings } = useQuery({
    queryKey: ["/api/user/settings"],
    queryFn: async () => {
      const response = await fetch('/api/user/settings');
      if (!response.ok) throw new Error('Failed to fetch user settings');
      return response.json();
    },
  });

  const showMode = userSettings?.showMode || 'personal';

  // Episode queries
  const { data: nextEpisodes, isLoading: nextLoading } = useQuery({
    queryKey: ["/api/user/episodes", "next", showMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', 'next');
      if (showMode) {
        params.set('showMode', showMode);
      }
      const response = await fetch(`/api/user/episodes?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch next episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
    enabled: !!userSettings, // Don't run until user settings are loaded
  });


  // Helper function to get the earliest episode per show
  const getNextEpisodesByShow = useMemo(() => {
    if (!nextEpisodes) return [];
    
    // Group episodes by show
    const grouped = new Map<number, (UserEpisode & { episode: Episode & { show: Show } })[]>();
    
    nextEpisodes.forEach(userEpisode => {
      const showId = userEpisode.episode.show.id;
      if (!grouped.has(showId)) {
        grouped.set(showId, []);
      }
      grouped.get(showId)!.push(userEpisode);
    });
    
    // For each show, find the earliest episode (by season, then episode number)
    return Array.from(grouped.entries()).map(([showId, episodes]) => {
      const earliestEpisode = episodes.sort((a, b) => {
        const seasonA = a.episode.season || 1;
        const seasonB = b.episode.season || 1;
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = a.episode.number || 0;
        const episodeB = b.episode.number || 0;
        return episodeA - episodeB;
      })[0];
      
      return earliestEpisode;
    }).sort((a, b) => a.episode.show.name.localeCompare(b.episode.show.name));
  }, [nextEpisodes]);



  // Episode update mutation with optimistic updates
  const updateEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      // Snapshot the previous values for rollback
      const previousData = queryClient.getQueryData(["/api/user/episodes", "next", showMode]);

      let updatedEpisodeInfo = null;

      // Find the episode in query cache and update optimistically
      if (previousData && Array.isArray(previousData)) {
        const episodeIndex = (previousData as any[]).findIndex((ep: any) => ep.episode.id === episodeId);
        if (episodeIndex !== -1) {
          const episode = (previousData as any[])[episodeIndex];
          
          // Store episode info for toast notification
          updatedEpisodeInfo = {
            showName: episode.episode.show.name,
            season: episode.episode.season,
            number: episode.episode.number
          };
          
          // Remove from next status cache if changing status away from "next"
          if (status !== "next") {
            const updatedData = (previousData as any[]).filter((_: any, index: number) => index !== episodeIndex);
            queryClient.setQueryData(["/api/user/episodes", "next", showMode], updatedData);
          }
        }
      }

      // Return a context object with the snapshotted value and episode info
      return { previousData, episodeInfo: updatedEpisodeInfo, episodeId };
    },
    onError: (error, variables, context) => {
      // Rollback changes
      if (context?.previousData) {
        queryClient.setQueryData(["/api/user/episodes", "next", showMode], context.previousData);
      }
      
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data, variables, context) => {
      // Invalidate episode queries to keep all lists synchronized
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


  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">

          {/* Countdown Timer for Upcoming Episodes */}
          <CountdownTimer />

          {/* Next to Watch Section */}
          <section>
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                <PlayCircle className="w-4 h-4 text-white" />
              </div>
              <h1 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-page-title">Next Up</h1>
              <p className="hidden sm:inline text-muted-foreground text-base ml-4 shrink-0">Your priority viewing queue</p>
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
              ) : getNextEpisodesByShow.length > 0 ? (
                <div className="space-y-4">
                  {getNextEpisodesByShow.map((userEpisode) => (
                    <EpisodeCard
                      key={userEpisode.id}
                      userEpisode={userEpisode}
                      onStatusChange={handleEpisodeStatusChange}
                      variant="wide"
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <PlayCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">No episodes queued</h3>
                  <p className="text-muted-foreground">Mark episodes as "Next" to build your viewing queue</p>
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