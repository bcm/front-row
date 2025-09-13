import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import { ArrowLeft, Calendar, Clock, Globe, Tv, ExternalLink, Star, Play } from "lucide-react";
import { Link } from "wouter";
import Header from "@/components/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Episode, Show, UserEpisode } from "@shared/schema";

interface EpisodeWithShowAndUserData extends Episode {
  show: Show;
  userEpisode?: UserEpisode;
}

export default function EpisodeDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: episodeData, isLoading, error } = useQuery<EpisodeWithShowAndUserData>({
    queryKey: ['/api/episodes', id],
    enabled: !!id,
  });

  // Episode update mutation with optimistic updates
  const updateEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ['/api/episodes', id] });

      // Snapshot the previous value for rollback
      const previousEpisodeData = queryClient.getQueryData(['/api/episodes', id]);

      // Optimistically update the episode data
      queryClient.setQueryData(['/api/episodes', id], (old: EpisodeWithShowAndUserData | undefined) => {
        if (!old) return old;
        return {
          ...old,
          userEpisode: {
            ...old.userEpisode,
            id: old.userEpisode?.id || `temp-${episodeId}`,
            userId: old.userEpisode?.userId || "demo-user",
            episodeId,
            status,
            triagedAt: new Date().toISOString(),
            addedAt: old.userEpisode?.addedAt || new Date().toISOString(),
            ...(status === "watched" && { watchedAt: new Date().toISOString() }),
            ...(status !== "watched" && old.userEpisode?.watchedAt && { watchedAt: null })
          }
        };
      });

      // Return a context object with the snapshotted value
      return { previousEpisodeData };
    },
    onError: (err, variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousEpisodeData) {
        queryClient.setQueryData(['/api/episodes', id], context.previousEpisodeData);
      }
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      // Invalidate related queries to ensure we have the latest data from server
      queryClient.invalidateQueries({ queryKey: ['/api/episodes', id] });
      queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/shows', episodeData?.showId, 'user-episodes'] });
    },
  });

  const handleEpisodeStatusToggle = () => {
    if (!episodeData) return;
    
    const currentStatus = episodeData.userEpisode?.status || "untriaged";
    
    // Cycle through all possible statuses: untriaged → next → later → watched → untriaged
    let newStatus: string;
    
    switch (currentStatus) {
      case "untriaged":
        newStatus = "next";
        break;
      case "next":
        newStatus = "later";
        break;
      case "later":
        newStatus = "watched";
        break;
      case "watched":
        newStatus = "untriaged";
        break;
      default:
        newStatus = "next";
        break;
    }
    
    updateEpisodeMutation.mutate({ episodeId: episodeData.id, status: newStatus });
  };

  const handleStatusChange = (newStatus: string) => {
    if (!episodeData) return;
    updateEpisodeMutation.mutate({ episodeId: episodeData.id, status: newStatus });
  };

  const getStatusBadge = (status?: string) => {
    if (!status || status === "untriaged") return null;
    
    switch (status) {
      case "next":
        return <Badge className="bg-blue-500/20 text-blue-400 border border-blue-500/30">NEXT</Badge>;
      case "later":
        return <Badge className="bg-orange-500/20 text-orange-400 border border-orange-500/30">LATER</Badge>;
      case "watched":
        return <Badge className="bg-purple-500/20 text-purple-400 border border-purple-500/30">WATCHED</Badge>;
      case "skipped":
        return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30">SKIPPED</Badge>;
      default:
        return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30">{status.toUpperCase()}</Badge>;
    }
  };

  const formatAirdate = (airdate: string | null) => {
    if (!airdate) return "Unknown";
    const date = new Date(airdate);
    return date.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric'
    });
  };

  const getEpisodeTitle = () => {
    if (!episodeData) return "";
    
    const seasonEpisode = getSeasonEpisodeFormat();
    if (episodeData.name) {
      return seasonEpisode ? `${seasonEpisode}: ${episodeData.name}` : episodeData.name;
    }
    return seasonEpisode || `Season ${episodeData.season}, Episode ${episodeData.number}`;
  };

  const getSeasonEpisodeFormat = () => {
    if (!episodeData) return null;
    if (episodeData.season && episodeData.number) {
      return `S${episodeData.season.toString().padStart(2, '0')}E${episodeData.number.toString().padStart(2, '0')}`;
    }
    return null;
  };

  const formatRating = (rating?: { average?: number }) => {
    if (!rating?.average) return null;
    return `${rating.average}/10`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-muted-foreground">Loading episode details...</div>
          </div>
        </main>
      </div>
    );
  }

  if (error || !episodeData) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col items-center justify-center min-h-[400px] space-y-4">
            <h1 className="text-2xl font-bold text-foreground">Episode Not Found</h1>
            <p className="text-muted-foreground">The episode you're looking for doesn't exist or couldn't be loaded.</p>
            <Link href="/library">
              <Button variant="outline" data-testid="button-back-library">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Library
              </Button>
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const { show } = episodeData;

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Navigation */}
        <div className="flex items-center space-x-4 mb-6">
          <Link href={`/show/${show.id}`}>
            <Button variant="outline" data-testid="button-back-show">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to {show.name}
            </Button>
          </Link>
        </div>

        {/* Episode Hero Section */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8">
          {/* Episode Image */}
          <div className="lg:col-span-4">
            <img 
              src={episodeData.image?.original || episodeData.image?.medium || show.image?.original || show.image?.medium || "/placeholder-episode.jpg"}
              alt={`${getEpisodeTitle()} poster`}
              className="w-full h-auto max-h-[500px] object-cover rounded-lg shadow-lg"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.src = "https://via.placeholder.com/400x300/374151/9ca3af?text=" + encodeURIComponent(getEpisodeTitle());
              }}
              data-testid="img-episode-poster"
            />
          </div>

          {/* Episode Details */}
          <div className="lg:col-span-8 space-y-6">
            {/* Show Information */}
            <div className="space-y-2">
              <Link href={`/show/${show.id}`}>
                <h2 className="text-lg font-medium text-primary hover:text-primary/80 transition-colors" data-testid="link-show-name">
                  {show.name}
                </h2>
              </Link>
              <h1 className="text-3xl md:text-4xl font-bold text-foreground" data-testid="text-episode-title">
                {getEpisodeTitle()}
              </h1>
            </div>

            {/* Status and Actions */}
            <div className="flex flex-wrap items-center gap-3">
              {getStatusBadge(episodeData.userEpisode?.status)}
              
              <Button 
                onClick={handleEpisodeStatusToggle}
                disabled={updateEpisodeMutation.isPending}
                data-testid="button-toggle-status"
              >
                {updateEpisodeMutation.isPending ? "Updating..." : "Toggle Status"}
              </Button>
              
              <div className="flex gap-2">
                {episodeData.userEpisode?.status !== "next" && (
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => handleStatusChange("next")}
                    disabled={updateEpisodeMutation.isPending}
                    data-testid="button-next"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    Watch Next
                  </Button>
                )}
                {episodeData.userEpisode?.status !== "later" && (
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => handleStatusChange("later")}
                    disabled={updateEpisodeMutation.isPending}
                    data-testid="button-later"
                  >
                    Watch Later
                  </Button>
                )}
                {episodeData.userEpisode?.status !== "watched" && (
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => handleStatusChange("watched")}
                    disabled={updateEpisodeMutation.isPending}
                    data-testid="button-watched"
                  >
                    Mark Watched
                  </Button>
                )}
              </div>
            </div>

            {/* Episode Metadata */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Air Date</p>
                <div className="flex items-center space-x-2">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium" data-testid="text-airdate">
                    {formatAirdate(episodeData.airdate)}
                  </span>
                </div>
              </div>
              
              {episodeData.runtime && (
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Runtime</p>
                  <div className="flex items-center space-x-2">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium" data-testid="text-runtime">
                      {episodeData.runtime} min
                    </span>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Season</p>
                <span className="text-sm font-medium" data-testid="text-season">
                  {episodeData.season || "Unknown"}
                </span>
              </div>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Episode</p>
                <span className="text-sm font-medium" data-testid="text-episode-number">
                  {episodeData.number || "Unknown"}
                </span>
              </div>
            </div>

            {/* Episode Summary */}
            {episodeData.summary && (
              <div className="space-y-3">
                <h3 className="text-lg font-semibold text-foreground">Summary</h3>
                <p className="text-muted-foreground leading-relaxed" data-testid="text-episode-summary">
                  {episodeData.summary.replace(/<[^>]*>/g, '')}
                </p>
              </div>
            )}
          </div>
        </div>

        <Separator className="my-8" />

        {/* Show Information Section */}
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start space-x-4">
              <img 
                src={show.image?.medium || "/placeholder-show.jpg"}
                alt={`${show.name} poster`}
                className="w-20 h-28 object-cover rounded-md flex-shrink-0"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.src = "https://via.placeholder.com/150x225/374151/9ca3af?text=" + encodeURIComponent(show.name);
                }}
              />
              <div className="flex-1 space-y-3">
                <div>
                  <Link href={`/show/${show.id}`}>
                    <h3 className="text-xl font-bold text-primary hover:text-primary/80 transition-colors" data-testid="link-show-title">
                      {show.name}
                    </h3>
                  </Link>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {show.genres && show.genres.length > 0 && (
                      <span className="text-sm text-muted-foreground">
                        {show.genres.join(', ')}
                      </span>
                    )}
                    {show.status && (
                      <Badge variant="outline" className="text-xs">
                        {show.status}
                      </Badge>
                    )}
                  </div>
                </div>
                
                {show.summary && (
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {show.summary.replace(/<[^>]*>/g, '')}
                  </p>
                )}
                
                <div className="flex items-center space-x-4 text-sm text-muted-foreground">
                  {show.network?.name && (
                    <div className="flex items-center space-x-1">
                      <Tv className="w-4 h-4" />
                      <span>{show.network.name}</span>
                    </div>
                  )}
                  {show.webChannel?.name && (
                    <div className="flex items-center space-x-1">
                      <Globe className="w-4 h-4" />
                      <span>{show.webChannel.name}</span>
                    </div>
                  )}
                  {show.rating?.average && (
                    <div className="flex items-center space-x-1">
                      <Star className="w-4 h-4" />
                      <span>{formatRating(show.rating)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}