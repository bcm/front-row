import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import { ArrowLeft, Star, Calendar, Clock, Globe, Tv, Users, Monitor, Play, Hash, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import Header from "@/components/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TVMazeShow } from "@/lib/tvmaze";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ShowStats {
  totalEpisodes: number;
  seasons: number;
  lastEpisode: any;
}

export default function ShowDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: show, isLoading, error } = useQuery<TVMazeShow>({
    queryKey: ['/api/shows', id],
    enabled: !!id,
  });

  const { data: showStats } = useQuery<ShowStats>({
    queryKey: ['/api/shows', id, 'stats'],
    queryFn: async () => {
      const response = await fetch(`/api/shows/${id}/stats`);
      if (!response.ok) {
        throw new Error('Failed to fetch show stats');
      }
      return response.json();
    },
    enabled: !!id,
  });

  const { data: episodes, isLoading: episodesLoading } = useQuery({
    queryKey: ['/api/shows', id, 'episodes'],
    queryFn: async () => {
      const response = await fetch(`/api/shows/${id}/episodes`);
      if (!response.ok) {
        throw new Error('Failed to fetch episodes');
      }
      return response.json();
    },
    enabled: !!id,
  });

  const { data: userEpisodeStatuses } = useQuery({
    queryKey: ['/api/shows', id, 'user-episodes'],
    queryFn: async () => {
      const response = await fetch(`/api/shows/${id}/user-episodes`);
      if (!response.ok) {
        throw new Error('Failed to fetch user episodes');
      }
      return response.json();
    },
    enabled: !!id,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/shows/${id}/sync`, {});
    },
    onSuccess: (data: any) => {
      // Invalidate and refetch show data and stats
      queryClient.invalidateQueries({ queryKey: ['/api/shows', id] });
      queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'stats'] });
      queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'episodes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
      
      toast({
        title: "Sync Complete",
        description: data.message || `Show synced successfully. ${data.episodesImported || 0} episodes imported.`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync show data from TVMaze",
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
      await queryClient.cancelQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });

      // Snapshot the previous value for rollback
      const previousUserEpisodes = queryClient.getQueryData(['/api/shows', id, 'user-episodes']);

      // Optimistically update the user episode status
      queryClient.setQueryData(['/api/shows', id, 'user-episodes'], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          [episodeId]: {
            ...old[episodeId],
            status,
            triagedAt: new Date().toISOString(),
            ...(status === "watched" && { watchedAt: new Date().toISOString() }),
            ...(status !== "watched" && old[episodeId]?.watchedAt && { watchedAt: null })
          }
        };
      });

      // Return a context object with the snapshotted value
      return { previousUserEpisodes };
    },
    onError: (err, variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousUserEpisodes) {
        queryClient.setQueryData(['/api/shows', id, 'user-episodes'], context.previousUserEpisodes);
      }
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      // Invalidate queries to ensure we have the latest data from server
      queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
    },
  });

  const handleEpisodeStatusToggle = (episodeId: number, currentStatus: string) => {
    const newStatus = currentStatus === "watched" ? "untriaged" : "watched";
    updateEpisodeMutation.mutate({ episodeId, status: newStatus });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-muted-foreground">Loading show details...</div>
          </div>
        </main>
      </div>
    );
  }

  if (error || !show) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col items-center justify-center min-h-[400px] space-y-4">
            <h1 className="text-2xl font-bold text-foreground">Show Not Found</h1>
            <p className="text-muted-foreground">The show you're looking for doesn't exist or couldn't be loaded.</p>
            <Link href="/library">
              <Button variant="outline">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Library
              </Button>
            </Link>
          </div>
        </main>
      </div>
    );
  }

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

  const formatGenres = (genres?: string[]) => {
    if (!genres || genres.length === 0) return 'Unknown';
    return genres.join(', ');
  };

  const formatRating = (rating?: { average?: number }) => {
    if (!rating?.average) return 'N/A';
    return `${rating.average}/10`;
  };

  const getNetworkInfo = () => {
    if (show.webChannel?.name) {
      return `${show.webChannel.name}${show.webChannel.country?.name ? ` (${show.webChannel.country.name})` : ''}`;
    }
    if (show.network?.name) {
      return `${show.network.name}${show.network.country?.name ? ` (${show.network.country.name})` : ''}`;
    }
    return 'Unknown Network';
  };

  const getScheduleAndRuntime = () => {
    const hasSchedule = show.schedule && show.schedule.days && show.schedule.days.length > 0;
    const hasRuntime = show.averageRuntime || show.runtime;
    
    if (!hasSchedule && !hasRuntime) {
      return 'Schedule not available';
    }
    
    let result = '';
    
    if (hasSchedule && show.schedule && show.schedule.days) {
      const days = show.schedule.days.join(', ');
      const time = show.schedule.time;
      
      if (time) {
        result = `${days} at ${time}`;
      } else {
        result = days;
      }
    }
    
    if (hasRuntime) {
      const runtime = show.averageRuntime || show.runtime;
      if (result) {
        result += ` (~${runtime} min)`;
      } else {
        result = `~${runtime} min`;
      }
    }
    
    return result || 'Schedule not available';
  };

  const getReturnDate = () => {
    if (show.ended) {
      // Parse and format the end date to US format if it's a valid date
      const endDate = new Date(show.ended);
      const formattedDate = isNaN(endDate.getTime()) ? show.ended : endDate.toLocaleDateString('en-US');
      return `Ended: ${formattedDate}`;
    }
    if (show.status === 'Running') {
      return 'Currently airing';
    }
    return 'Return date not available';
  };

  const cleanSummary = (summary?: string) => {
    if (!summary) return 'No description available.';
    // Remove HTML tags from the summary
    return summary.replace(/<[^>]*>/g, '');
  };

  const groupEpisodesBySeason = (episodes: any[]) => {
    if (!episodes) return {};
    
    const grouped = episodes.reduce((acc: Record<number, any[]>, episode: any) => {
      const season = episode.season || 0;
      if (!acc[season]) {
        acc[season] = [];
      }
      acc[season].push(episode);
      return acc;
    }, {});

    // Sort episodes within each season by episode number (reverse order - newest first)
    Object.keys(grouped).forEach(season => {
      grouped[parseInt(season)].sort((a: any, b: any) => (b.number || 0) - (a.number || 0));
    });

    return grouped;
  };

  const getEpisodeStatusBadge = (episodeId: number) => {
    if (!userEpisodeStatuses || !userEpisodeStatuses[episodeId]) {
      return (
        <Badge 
          className="bg-muted text-muted-foreground border border-muted-foreground/30 text-xs cursor-pointer hover:bg-green-500/20 hover:text-green-400 hover:border-green-500/30 transition-colors"
          onClick={() => handleEpisodeStatusToggle(episodeId, "untriaged")}
          data-testid={`badge-episode-status-${episodeId}`}
        >
          UNWATCHED
        </Badge>
      );
    }

    const status = userEpisodeStatuses[episodeId].status;
    
    switch (status) {
      case "watched":
        return (
          <Badge 
            className="bg-green-500/20 text-green-400 border border-green-500/30 text-xs cursor-pointer hover:bg-muted hover:text-muted-foreground hover:border-muted-foreground/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            WATCHED
          </Badge>
        );
      case "skipped":
        return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30 text-xs">SKIPPED</Badge>;
      case "next":
        return <Badge className="bg-blue-500/20 text-blue-400 border border-blue-500/30 text-xs">NEXT</Badge>;
      case "later":
        return <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 text-xs">LATER</Badge>;
      case "untriaged":
        return (
          <Badge 
            className="bg-orange-500/20 text-orange-400 border border-orange-500/30 text-xs cursor-pointer hover:bg-green-500/20 hover:text-green-400 hover:border-green-500/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            NEW
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Back Button and Actions */}
        <div className="mb-6 flex items-center justify-between">
          <Link href="/library">
            <Button variant="outline" size="sm" data-testid="button-back-to-library">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Library
            </Button>
          </Link>
          
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="button-sync-show"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            {syncMutation.isPending ? 'Syncing...' : 'Sync from TVMaze'}
          </Button>
        </div>

        {/* Show Header */}
        <div className="flex flex-col lg:flex-row gap-8 mb-8">
          {/* Poster */}
          <div className="flex-shrink-0">
            <img
              src={show.image?.original || show.image?.medium || "/placeholder-show.jpg"}
              alt={`${show.name} poster`}
              className="w-64 h-96 object-cover rounded-lg shadow-lg"
              data-testid={`img-show-poster-${show.id}`}
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.src = "https://via.placeholder.com/256x384/374151/9ca3af?text=" + encodeURIComponent(show.name || 'Show');
              }}
            />
          </div>

          {/* Show Info */}
          <div className="flex-1 space-y-6">
            {/* Title and Status */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h1 className="text-4xl font-bold text-foreground flex-1 min-w-0 mr-4" data-testid={`text-show-title-${show.id}`}>
                  {show.name}
                </h1>
                {show.rating?.average && (
                  <div className="flex items-center space-x-1 flex-shrink-0" data-testid={`text-show-rating-${show.id}`}>
                    <Star className="w-5 h-5 text-yellow-500" />
                    <span className="text-foreground font-medium">{formatRating(show.rating)}</span>
                  </div>
                )}
              </div>
              {show.status && (
                <Badge className={getStatusColor(show.status)} data-testid={`badge-show-status-${show.id}`}>
                  {show.status}
                </Badge>
              )}
            </div>

            {/* Meta Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {show.premiered && (
                <div className="flex items-center space-x-2" data-testid={`text-show-premiered-${show.id}`}>
                  <Calendar className="w-5 h-5 text-muted-foreground" />
                  <span className="text-foreground">
                    Premiered: {new Date(show.premiered).toLocaleDateString('en-US')}
                  </span>
                </div>
              )}

              <div className="flex items-center space-x-2" data-testid={`text-show-return-date-${show.id}`}>
                <Calendar className="w-5 h-5 text-muted-foreground" />
                <span className="text-foreground">{getReturnDate()}</span>
              </div>

              <div className="flex items-center space-x-2" data-testid={`text-show-network-${show.id}`}>
                {show.webChannel ? (
                  <Monitor className="w-5 h-5 text-muted-foreground" />
                ) : (
                  <Tv className="w-5 h-5 text-muted-foreground" />
                )}
                <span className="text-foreground">{getNetworkInfo()}</span>
              </div>

              <div className="flex items-center space-x-2" data-testid={`text-show-schedule-${show.id}`}>
                <Clock className="w-5 h-5 text-muted-foreground" />
                <span className="text-foreground">{getScheduleAndRuntime()}</span>
              </div>

              {show.type && (
                <div className="flex items-center space-x-2" data-testid={`text-show-type-${show.id}`}>
                  <Play className="w-5 h-5 text-muted-foreground" />
                  <span className="text-foreground">{show.type}</span>
                </div>
              )}

              {showStats && (
                <div className="flex items-center space-x-2" data-testid={`text-show-episodes-${show.id}`}>
                  <Hash className="w-5 h-5 text-muted-foreground" />
                  <span className="text-foreground">
                    {showStats.totalEpisodes} episodes ({showStats.seasons} seasons)
                  </span>
                </div>
              )}

              {show.officialSite && (
                <div className="flex items-center space-x-2 md:col-span-2">
                  <Globe className="w-5 h-5 text-muted-foreground" />
                  <a 
                    href={show.officialSite} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:text-primary/80 underline"
                    data-testid={`link-show-official-site-${show.id}`}
                  >
                    Official Site
                  </a>
                </div>
              )}

              <div className="flex items-center space-x-2 md:col-span-2">
                <ExternalLink className="w-5 h-5 text-muted-foreground" />
                <a 
                  href={`https://www.tvmaze.com/shows/${show.id}`} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline"
                  data-testid={`link-show-tvmaze-${show.id}`}
                >
                  View on TVMaze
                </a>
              </div>
            </div>

            {/* Summary */}
            {show.summary && (
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-foreground">Summary</h2>
                <p className="text-muted-foreground leading-relaxed" data-testid={`text-show-summary-${show.id}`}>
                  {cleanSummary(show.summary)}
                </p>
              </div>
            )}

            {/* Genres */}
            {show.genres && show.genres.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-foreground">Genres</h2>
                <div className="flex flex-wrap gap-2" data-testid={`text-show-genres-${show.id}`}>
                  {show.genres.map((genre) => (
                    <span
                      key={genre}
                      className="bg-accent text-accent-foreground px-3 py-1 rounded-full text-sm"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Episodes List */}
            {episodes && episodes.length > 0 && (
              <div className="space-y-4 mt-8">
                <h2 className="text-2xl font-semibold text-foreground">Episodes</h2>
                
                {episodesLoading ? (
                  <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                        <div className="h-6 bg-muted rounded mb-4 w-32"></div>
                        <div className="space-y-3">
                          {Array.from({ length: 5 }).map((_, j) => (
                            <div key={j} className="flex space-x-3">
                              <div className="w-16 h-12 bg-muted rounded flex-shrink-0"></div>
                              <div className="flex-1 space-y-2">
                                <div className="h-4 bg-muted rounded"></div>
                                <div className="h-3 bg-muted rounded w-3/4"></div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {Object.entries(groupEpisodesBySeason(episodes))
                      .sort(([a], [b]) => parseInt(b) - parseInt(a)) // Sort seasons in reverse order
                      .map(([season, seasonEpisodes]) => (
                        <div key={season} className="bg-card rounded-lg p-6 border border-border">
                          <h3 className="text-xl font-semibold text-foreground mb-4 border-b border-border pb-2">
                            Season {season}
                          </h3>
                          <div className="space-y-3">
                            {seasonEpisodes.map((episode: any) => (
                              <div 
                                key={episode.id} 
                                className="flex space-x-4 p-3 hover:bg-muted/50 rounded-md transition-colors"
                                data-testid={`episode-${episode.id}`}
                              >
                                <div className="w-16 h-12 bg-muted rounded overflow-hidden flex-shrink-0">
                                  {episode.image?.medium ? (
                                    <img
                                      src={episode.image.medium}
                                      alt={`Episode ${episode.number}`}
                                      className="w-full h-full object-cover"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-muted">
                                      <Play className="w-4 h-4 text-muted-foreground" />
                                    </div>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between">
                                    <div className="flex-1 min-w-0">
                                      <h4 className="font-medium text-foreground truncate">
                                        {episode.number ? `${episode.number}. ` : ''}{episode.name || `Episode ${episode.number}`}
                                      </h4>
                                      {episode.summary && (
                                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                          {episode.summary.replace(/<[^>]*>/g, '')}
                                        </p>
                                      )}
                                    </div>
                                    <div className="flex flex-col items-end text-sm text-muted-foreground ml-4 flex-shrink-0 space-y-1">
                                      {getEpisodeStatusBadge(episode.id)}
                                      {episode.airdate && (
                                        <span>{new Date(episode.airdate).toLocaleDateString('en-US')}</span>
                                      )}
                                      {episode.runtime && (
                                        <span>{episode.runtime} min</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}