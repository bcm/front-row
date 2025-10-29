import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Header from "@/components/header";
import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, X, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Recommendation } from "@shared/schema";

export default function Recommendations() {
  const { toast } = useToast();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [processingTmdbId, setProcessingTmdbId] = useState<number | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());

  const { data: recommendations = [], isLoading } = useQuery<Recommendation[]>({
    queryKey: ["/api/recommendations"],
    staleTime: 1000 * 60 * 5,
  });

  // Filter out optimistically dismissed recommendations
  const visibleRecommendations = recommendations.filter(rec => !dismissedIds.has(rec.tmdbId));

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/recommendations/refresh");
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      toast({
        title: "Recommendations refreshed",
        description: `Found ${data.imported} new recommendations`,
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to refresh recommendations",
      });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (tmdbId: number) => {
      // Optimistically remove from UI
      setDismissedIds(prev => new Set(prev).add(tmdbId));
      
      const response = await apiRequest("POST", "/api/recommendations/dismiss", { tmdbId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      toast({
        title: "Dismissed",
        description: "Show removed from recommendations",
      });
    },
    onError: (error: Error, tmdbId: number) => {
      // Revert optimistic update on error
      setDismissedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(tmdbId);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to dismiss recommendation",
      });
    },
  });

  const acceptMutation = useMutation({
    mutationFn: async ({ tmdbId, showName }: { tmdbId: number; showName: string }) => {
      setProcessingTmdbId(tmdbId);
      const tvmazeResponse = await fetch(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(showName)}`
      );
      const tvmazeResults = await tvmazeResponse.json();

      if (tvmazeResults.length === 0) {
        throw new Error("Show not found on TVMaze");
      }

      const tvmazeId = tvmazeResults[0].show.id;

      const response = await apiRequest("POST", "/api/recommendations/accept", { tmdbId, tvmazeId });
      return response.json();
    },
    onSuccess: () => {
      setProcessingTmdbId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Added to library",
        description: "Show added successfully. Episodes are being synced in the background.",
      });
    },
    onError: (error: Error) => {
      setProcessingTmdbId(null);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add show",
      });
    },
  });

  if (isLoading) {
    return (
      <>
        <Header />
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
        <FloatingAddButton onClick={() => setShowAddDialog(true)} />
        <AddShowDialog open={showAddDialog} onOpenChange={setShowAddDialog} />
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="heading-recommendations">
              <Sparkles className="h-7 w-7" />
              Recommendations
            </h1>
            <p className="text-muted-foreground mt-1">
              Personalized show suggestions based on your library
            </p>
          </div>
          <Button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            variant="outline"
            data-testid="button-refresh-recommendations"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>

        {visibleRecommendations.length === 0 ? (
          <Card className="p-12 text-center">
            <Sparkles className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-xl font-semibold mb-2" data-testid="text-no-recommendations">No recommendations yet</h3>
            <p className="text-muted-foreground mb-4">
              Add more shows to your library to get personalized recommendations
            </p>
            <Button
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              data-testid="button-generate-recommendations"
            >
              {refreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Generate Recommendations
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visibleRecommendations.map((rec) => (
              <Card
                key={rec.id}
                className="overflow-hidden flex flex-col"
                data-testid={`card-recommendation-${rec.tmdbId}`}
              >
                {rec.posterPath && (
                  <img
                    src={`https://image.tmdb.org/t/p/w500${rec.posterPath}`}
                    alt={rec.name}
                    className="w-full aspect-[2/3] object-cover"
                    data-testid={`img-poster-${rec.tmdbId}`}
                  />
                )}
                <div className="p-4 flex-1 flex flex-col">
                  <h3 className="font-semibold text-lg mb-2" data-testid={`text-show-name-${rec.tmdbId}`}>
                    {rec.name}
                  </h3>
                  
                  {rec.genres && rec.genres.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {rec.genres.slice(0, 3).map((genre) => (
                        <Badge key={genre} variant="secondary" className="text-xs">
                          {genre}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {rec.voteAverage && (
                    <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
                      <span className="font-medium" data-testid={`text-rating-${rec.tmdbId}`}>
                        ⭐ {(rec.voteAverage / 10).toFixed(1)}
                      </span>
                      {rec.firstAirDate && (
                        <span>• {new Date(rec.firstAirDate).getFullYear()}</span>
                      )}
                    </div>
                  )}

                  {rec.overview && (
                    <p className="text-sm text-muted-foreground line-clamp-3 mb-4 flex-1">
                      {rec.overview}
                    </p>
                  )}

                  <div className="flex gap-2 mt-auto">
                    <Button
                      onClick={() => acceptMutation.mutate({ tmdbId: rec.tmdbId, showName: rec.name })}
                      disabled={processingTmdbId === rec.tmdbId}
                      className="flex-1"
                      data-testid={`button-accept-${rec.tmdbId}`}
                    >
                      {processingTmdbId === rec.tmdbId ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4 mr-2" />
                      )}
                      Add
                    </Button>
                    <Button
                      onClick={() => dismissMutation.mutate(rec.tmdbId)}
                      disabled={dismissMutation.isPending}
                      variant="outline"
                      size="icon"
                      data-testid={`button-dismiss-${rec.tmdbId}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
      <FloatingAddButton onClick={() => setShowAddDialog(true)} />
      <AddShowDialog open={showAddDialog} onOpenChange={setShowAddDialog} />
    </>
  );
}
