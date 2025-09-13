import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Tv, Loader2, Download } from "lucide-react";
import { UserShow, Show } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";

type LibraryShow = UserShow & { show: Show };

export default function FollowedShows() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <section>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-3">
            <div className="w-6 h-6 bg-primary rounded-full flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-primary-foreground" />
            </div>
            <h2 className="text-2xl font-bold" data-testid="text-section-title-library">
              Library
            </h2>
            <span className="bg-primary text-primary-foreground px-2 py-1 rounded-full text-xs font-bold" data-testid="text-library-count">
              {libraryShows?.length || 0}
            </span>
          </div>
          <div className="flex items-center space-x-4">
            <p className="text-muted-foreground text-sm">Your complete TV show collection</p>
            <Button 
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending}
              size="sm"
              variant="outline"
              data-testid="button-import-shows"
            >
              {importMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              Import from TVMaze
            </Button>
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
        {libraryShows && libraryShows.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {libraryShows.map((libraryShow) => (
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
                    <h3 className="font-semibold text-sm mb-1 truncate" data-testid={`text-title-${libraryShow.showId}`}>
                      {libraryShow.show.name}
                    </h3>
                    <p className="text-xs text-muted-foreground mb-2" data-testid={`text-network-${libraryShow.showId}`}>
                      {libraryShow.show.network?.name || "Unknown Network"}
                    </p>
                    <div className="flex items-center space-x-2">
                      <span className="bg-secondary text-secondary-foreground px-2 py-1 rounded text-xs" data-testid={`text-user-status-${libraryShow.showId}`}>
                        {libraryShow.status}
                      </span>
                      {libraryShow.show.status && (
                        <span className="bg-accent text-accent-foreground px-2 py-1 rounded text-xs" data-testid={`text-show-status-${libraryShow.showId}`}>
                          {libraryShow.show.status}
                        </span>
                      )}
                      {libraryShow.show.rating?.average && (
                        <span className="text-xs text-muted-foreground" data-testid={`text-rating-${libraryShow.showId}`}>
                          ⭐ {libraryShow.show.rating.average}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                
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

                {/* Summary */}
                {libraryShow.show.summary && (
                  <div className="text-xs text-muted-foreground leading-relaxed">
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
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {libraryShows && libraryShows.length === 0 && !isLoading && !error && (
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