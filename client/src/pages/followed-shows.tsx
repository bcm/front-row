import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Tv, Loader2, Download, PlayCircle, RefreshCw, Eye, EyeOff } from "lucide-react";
import { UserShow, Show, UserSettings } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { useState, useMemo } from "react";

type LibraryShow = UserShow & { show: Show };

export default function FollowedShows() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncingShowId, setSyncingShowId] = useState<number | null>(null);

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'Running':
        return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'Ended':
        return 'bg-red-500/20 text-red-400 border-red-500/30';
      case 'To Be Determined':
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      default:
        return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    }
  };

  const { data: libraryShows, isLoading, error } = useQuery({
    queryKey: ["/api/library"],
    queryFn: async () => {
      const response = await fetch("/api/library");
      if (!response.ok) {
        throw new Error("Failed to fetch library");
      }
      return response.json() as Promise<LibraryShow[]>;
    },
  });

  // User settings query
  const { data: userSettings } = useQuery({
    queryKey: ["/api/user/settings"],
    queryFn: async () => {
      const response = await fetch("/api/user/settings");
      if (!response.ok) {
        throw new Error("Failed to fetch user settings");
      }
      return response.json() as Promise<UserSettings>;
    },
  });

  // Filter shows based on settings
  const filteredShows = useMemo(() => {
    if (!libraryShows || !userSettings) return libraryShows || [];
    
    if (userSettings.hideFinishedShows) {
      return libraryShows.filter(show => show.show.status !== "Ended");
    }
    
    return libraryShows;
  }, [libraryShows, userSettings]);

  // Settings update mutation with optimistic updates
  const updateSettingsMutation = useMutation({
    mutationFn: async (settings: Partial<UserSettings>) => {
      return apiRequest("PATCH", "/api/user/settings", settings);
    },
    onMutate: async (newSettings: Partial<UserSettings>) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ["/api/user/settings"] });

      // Snapshot the previous value for rollback
      const previousSettings = queryClient.getQueryData(["/api/user/settings"]) as UserSettings;

      // Optimistically update the settings
      if (previousSettings) {
        queryClient.setQueryData(["/api/user/settings"], {
          ...previousSettings,
          ...newSettings,
        });
      }

      // Return context object with snapshotted value
      return { previousSettings };
    },
    onError: (error: any, newSettings, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousSettings) {
        queryClient.setQueryData(["/api/user/settings"], context.previousSettings);
      }
      
      toast({
        title: "Error",
        description: error.message || "Failed to update settings",
        variant: "destructive",
      });
    },
    onSettled: () => {
      // Always refetch after error or success to ensure we have the latest data
      queryClient.invalidateQueries({ queryKey: ["/api/user/settings"] });
    },
  });

  // Sync individual show mutation
  const syncShowMutation = useMutation({
    mutationFn: async ({ showId, showName }: { showId: number; showName: string }) => {
      setSyncingShowId(showId);
      return { response: await apiRequest("POST", `/api/shows/${showId}/sync`, {}), showName };
    },
    onSuccess: (data: any, { showId }: { showId: number; showName: string }) => {
      setSyncingShowId(null);
      // Invalidate and refetch show data and stats
      queryClient.invalidateQueries({ queryKey: ["/api/shows", showId] });
      queryClient.invalidateQueries({ queryKey: ["/api/shows", showId, "stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/shows", showId, "episodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/shows", showId, "user-episodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/library"] });
      
      toast({
        title: "Sync Complete",
        description: data.response.message || `"${data.showName}" synced successfully. ${data.response.episodesImported || 0} episodes imported.`,
      });
    },
    onError: (error: any, { showName }: { showId: number; showName: string }) => {
      setSyncingShowId(null);
      toast({
        title: "Sync Failed",
        description: error.message || `Failed to sync "${showName}" from TVMaze`,
        variant: "destructive",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/library/import", {});
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/library"] });
      toast({
        title: "Import completed",
        description: `Imported ${data.imported} shows, skipped ${data.skipped} existing shows.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Import failed",
        description: error.message || "Failed to import shows from TVMaze",
        variant: "destructive",
      });
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

  const handleImportEpisodes = () => {
    importEpisodesMutation.mutate();
  };

  const handleSyncScrobbles = () => {
    syncScrobblesMutation.mutate();
  };

  const ButtonWithTooltip = ({ children, tooltip, ...props }: { children: React.ReactNode; tooltip: string; [key: string]: any }) => (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Button {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="hidden lg:block">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <section>
        <div className="space-y-4 mb-6">
          {/* Title Row */}
          <div className="flex items-center space-x-3">
            <div className="w-6 h-6 bg-primary rounded-full flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-primary-foreground" />
            </div>
            <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-library">
              Library
            </h2>
            <div className="flex items-center space-x-2 shrink-0">
              <span className="bg-primary text-primary-foreground px-2 py-1 rounded-full text-xs font-bold" data-testid="text-library-count">
                {filteredShows?.length || 0}
              </span>
              {libraryShows && filteredShows && libraryShows.length !== filteredShows.length && (
                <span className="hidden sm:inline text-xs text-muted-foreground">
                  ({libraryShows.length - filteredShows.length} hidden)
                </span>
              )}
            </div>
          </div>
          
          {/* Controls Row */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center space-x-2">
              <Switch
                id="hide-finished-shows"
                checked={!userSettings?.hideFinishedShows}
                onCheckedChange={(checked) => {
                  updateSettingsMutation.mutate({ hideFinishedShows: !checked });
                }}
                disabled={updateSettingsMutation.isPending}
                data-testid="switch-hide-finished-shows"
              />
              <Label htmlFor="hide-finished-shows" className="text-sm text-muted-foreground cursor-pointer">
                Show finished shows
              </Label>
            </div>
            
            <div className="flex flex-wrap gap-2">
              <ButtonWithTooltip 
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending}
                size="sm"
                variant="outline"
                data-testid="button-import-shows"
                tooltip="Import from TVMaze"
              >
                {importMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span className="ml-2 sm:hidden">Import</span>
                <span className="ml-2 hidden lg:inline">Import from TVMaze</span>
              </ButtonWithTooltip>
              <ButtonWithTooltip 
                onClick={handleImportEpisodes}
                disabled={importEpisodesMutation.isPending}
                size="sm"
                data-testid="button-import-episodes"
                tooltip="Import Episodes"
              >
                <RefreshCw className="w-4 h-4" />
                <span className="ml-2 sm:hidden">Episodes</span>
                <span className="ml-2 hidden lg:inline">{importEpisodesMutation.isPending ? "Importing..." : "Import Episodes"}</span>
              </ButtonWithTooltip>
              <ButtonWithTooltip 
                onClick={handleSyncScrobbles}
                disabled={syncScrobblesMutation.isPending}
                size="sm"
                variant="outline"
                data-testid="button-sync-scrobbles"
                tooltip="Sync Watched"
              >
                <PlayCircle className="w-4 h-4" />
                <span className="ml-2 sm:hidden">Sync</span>
                <span className="ml-2 hidden lg:inline">{syncScrobblesMutation.isPending ? "Syncing..." : "Sync Watched"}</span>
              </ButtonWithTooltip>
            </div>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6 text-center">
            <Tv className="w-12 h-12 mx-auto text-destructive mb-4" />
            <h3 className="text-lg font-semibold text-destructive mb-2">Failed to load library</h3>
            <p className="text-destructive/80 text-sm" data-testid="text-error-message">
              {error.message}
            </p>
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                <div className="flex space-x-3 mb-4">
                  <div className="w-12 h-16 bg-muted rounded-md"></div>
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded"></div>
                    <div className="h-3 bg-muted rounded w-3/4"></div>
                    <div className="h-5 bg-muted rounded w-1/2"></div>
                  </div>
                </div>
                <div className="h-3 bg-muted rounded mb-2"></div>
                <div className="h-3 bg-muted rounded w-2/3"></div>
              </div>
            ))}
          </div>
        )}

        {/* Shows Grid */}
        {filteredShows && filteredShows.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredShows.map((libraryShow) => (
              <div
                key={libraryShow.id}
                className="bg-card rounded-lg p-4 border border-border hover:shadow-lg transition-shadow"
                data-testid={`card-library-show-${libraryShow.showId}`}
              >
                <div className="flex space-x-3 mb-4">
                  <div className="w-12 h-16 bg-muted rounded-md overflow-hidden flex-shrink-0">
                    {libraryShow.show.image?.medium ? (
                      <img
                        src={libraryShow.show.image.medium}
                        alt={libraryShow.show.name}
                        className="w-full h-full object-cover"
                        data-testid={`img-poster-${libraryShow.showId}`}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-muted">
                        <Tv className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <Link href={`/show/${libraryShow.showId}`}>
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="font-semibold text-sm truncate hover:text-primary transition-colors cursor-pointer flex-1 min-w-0 mr-2" data-testid={`text-title-${libraryShow.showId}`}>
                          {libraryShow.show.name}
                        </h3>
                        {libraryShow.show.rating?.average && (
                          <span className="text-xs text-muted-foreground flex-shrink-0" data-testid={`text-rating-${libraryShow.showId}`}>
                            ⭐ {libraryShow.show.rating.average}
                          </span>
                        )}
                      </div>
                    </Link>
                    <p className="text-xs text-muted-foreground mb-2" data-testid={`text-network-${libraryShow.showId}`}>
                      {libraryShow.show.webChannel?.name || libraryShow.show.network?.name || "Unknown Network"}
                    </p>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        {/* Status functionality removed */}
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              syncShowMutation.mutate({ showId: libraryShow.showId, showName: libraryShow.show.name });
                            }}
                            disabled={syncingShowId === libraryShow.showId}
                            className="h-6 w-6 p-0"
                            data-testid={`button-sync-show-${libraryShow.showId}`}
                          >
                            <RefreshCw className={`w-3 h-3 ${syncingShowId === libraryShow.showId ? 'animate-spin' : ''}`} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Sync from TVMaze</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>
                
                {/* Summary */}
                {libraryShow.show.summary && (
                  <div className="text-xs text-muted-foreground leading-relaxed mb-3">
                    <div
                      className="line-clamp-3"
                      dangerouslySetInnerHTML={{
                        __html: libraryShow.show.summary
                          .replace(/<[^>]*>/g, "")
                          .substring(0, 120) + (libraryShow.show.summary.length > 120 ? "..." : "")
                      }}
                      data-testid={`text-summary-${libraryShow.showId}`}
                    />
                  </div>
                )}

                {/* Genres */}
                {libraryShow.show.genres && libraryShow.show.genres.length > 0 && (
                  <div className="mb-3">
                    <div className="flex flex-wrap gap-1">
                      {libraryShow.show.genres.slice(0, 3).map((genre) => (
                        <span
                          key={genre}
                          className="bg-accent text-accent-foreground px-2 py-1 rounded-full text-xs"
                          data-testid={`text-genre-${libraryShow.showId}-${genre.toLowerCase()}`}
                        >
                          {genre}
                        </span>
                      ))}
                      {libraryShow.show.genres.length > 3 && (
                        <span className="text-xs text-muted-foreground px-2 py-1">
                          +{libraryShow.show.genres.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && libraryShows && libraryShows.length === 0 && (
          <div className="text-center py-12">
            <BookOpen className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold text-muted-foreground mb-2">No shows in library</h3>
            <p className="text-muted-foreground text-sm mb-4" data-testid="text-empty-state">
              Your library is empty. Import shows from TVMaze or add shows manually to start building your collection.
            </p>
            <Button 
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending}
              data-testid="button-import-shows-empty"
            >
              {importMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              Import from TVMaze
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}