import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Header from "@/components/header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, X, Plus, RefreshCw, Calendar, CheckCheck } from "lucide-react";
import { useState } from "react";
import type { NewReleaseShow } from "@shared/schema";

interface NewReleasesResponse {
  shows: NewReleaseShow[];
  lastChecked: string | null;
  fromCache: boolean;
}

export default function NewReleases() {
  const { toast } = useToast();
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());

  const { data, isLoading } = useQuery<NewReleasesResponse>({
    queryKey: ["/api/new-releases"],
    staleTime: 1000 * 60 * 5,
  });

  const shows = data?.shows || [];
  const lastChecked = data?.lastChecked ? new Date(data.lastChecked) : null;

  const visibleShows = shows.filter(show => !dismissedIds.has(show.id));

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/new-releases/refresh");
      return response.json();
    },
    onSuccess: (result: NewReleasesResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      toast({
        title: "New releases refreshed",
        description: `Showing ${result.shows.length} new releases`,
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to refresh new releases",
      });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (tvmazeId: number) => {
      setDismissedIds(prev => new Set(prev).add(tvmazeId));
      
      const response = await apiRequest("POST", "/api/new-releases/dismiss", { tvmazeId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      toast({
        title: "Dismissed",
        description: "Show removed from new releases",
      });
    },
    onError: (error: Error, tvmazeId: number) => {
      setDismissedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(tvmazeId);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to dismiss show",
      });
    },
  });

  const addMutation = useMutation({
    mutationFn: async (show: NewReleaseShow) => {
      setDismissedIds(prev => new Set(prev).add(show.id));
      setProcessingId(show.id);
      
      const response = await apiRequest("POST", "/api/new-releases/add", { tvmazeId: show.id });
      return response.json();
    },
    onSuccess: () => {
      setProcessingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Added to library",
        description: "Show added successfully. Episodes are being synced in the background.",
      });
    },
    onError: (error: Error, show: NewReleaseShow) => {
      setProcessingId(null);
      setDismissedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(show.id);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add show",
      });
    },
  });

  const addWatchedMutation = useMutation({
    mutationFn: async (show: NewReleaseShow) => {
      setDismissedIds(prev => new Set(prev).add(show.id));
      setProcessingId(show.id);
      
      const response = await apiRequest("POST", "/api/new-releases/add-watched", { tvmazeId: show.id });
      return response.json();
    },
    onSuccess: () => {
      setProcessingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Added as watched",
        description: "Show added successfully. All episodes are being marked as watched.",
      });
    },
    onError: (error: Error, show: NewReleaseShow) => {
      setProcessingId(null);
      setDismissedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(show.id);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add show",
      });
    },
  });

  function stripHtml(html: string | null): string {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, "");
  }

  function formatPremiereDate(dateStr: string | null): string {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays > 0) {
      if (diffDays === 1) return "Tomorrow";
      if (diffDays <= 7) return `In ${diffDays} days`;
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } else if (diffDays === 0) {
      return "Today";
    } else {
      const absDays = Math.abs(diffDays);
      if (absDays === 1) return "Yesterday";
      if (absDays <= 7) return `${absDays} days ago`;
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }

  if (isLoading) {
    return (
      <>
        <Header />
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="heading-new-releases">
              <Calendar className="h-7 w-7" />
              New Releases
            </h1>
            <p className="text-muted-foreground mt-1">
              Recently premiered and upcoming shows
              {lastChecked && (
                <span className="text-xs ml-2">
                  (Last checked: {lastChecked.toLocaleTimeString()})
                </span>
              )}
            </p>
          </div>
          <Button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            variant="outline"
            data-testid="button-refresh-new-releases"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>

        {refreshMutation.isPending ? (
          <Card className="p-12 text-center">
            <Loader2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-spin" />
            <h3 className="text-xl font-semibold mb-2">Fetching new releases...</h3>
            <p className="text-muted-foreground">
              Checking TV schedules for new show premieres.
            </p>
          </Card>
        ) : visibleShows.length === 0 ? (
          <Card className="p-12 text-center">
            <Calendar className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-xl font-semibold mb-2" data-testid="text-no-new-releases">No new releases</h3>
            <p className="text-muted-foreground mb-4">
              Check back later for newly premiered shows
            </p>
            <Button
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              data-testid="button-fetch-new-releases"
            >
              {refreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Fetch New Releases
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visibleShows.map((show) => (
              <Card
                key={show.id}
                className="overflow-hidden flex flex-col"
                data-testid={`card-new-release-${show.id}`}
              >
                {(show.image?.original || show.image?.medium) && (
                  <img
                    src={show.image.original || show.image.medium}
                    alt={show.name}
                    className="w-full aspect-[2/3] object-cover"
                    data-testid={`img-poster-${show.id}`}
                  />
                )}
                <div className="p-4 flex-1 flex flex-col">
                  <h3 className="font-semibold text-lg mb-2" data-testid={`text-show-name-${show.id}`}>
                    {show.name}
                  </h3>
                  
                  {show.genres && show.genres.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {show.genres.slice(0, 3).map((genre) => (
                        <Badge key={genre} variant="secondary" className="text-xs">
                          {genre}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
                    <span className="font-medium" data-testid={`text-premiere-${show.id}`}>
                      📅 {formatPremiereDate(show.premiered)}
                    </span>
                    {(show.network || show.webChannel) && (
                      <span>• {show.network || show.webChannel}</span>
                    )}
                  </div>

                  {show.summary && (
                    <p className="text-sm text-muted-foreground line-clamp-3 mb-4 flex-1">
                      {stripHtml(show.summary)}
                    </p>
                  )}

                  <div className="flex flex-col gap-2 mt-auto">
                    <div className="flex gap-2">
                      <Button
                        onClick={() => addMutation.mutate(show)}
                        disabled={processingId === show.id}
                        className="flex-1"
                        data-testid={`button-add-${show.id}`}
                      >
                        {processingId === show.id ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4 mr-2" />
                        )}
                        Add
                      </Button>
                      <Button
                        onClick={() => dismissMutation.mutate(show.id)}
                        disabled={dismissMutation.isPending}
                        variant="outline"
                        size="icon"
                        data-testid={`button-dismiss-${show.id}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <Button
                      onClick={() => addWatchedMutation.mutate(show)}
                      disabled={processingId === show.id}
                      variant="secondary"
                      className="w-full"
                      data-testid={`button-add-watched-${show.id}`}
                    >
                      {processingId === show.id ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <CheckCheck className="h-4 w-4 mr-2" />
                      )}
                      Watched
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
