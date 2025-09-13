import { useQuery } from "@tanstack/react-query";
import { BookOpen, Tv, Loader2 } from "lucide-react";

interface FollowedShow {
  show_id: number;
  _embedded: {
    show: {
      id: number;
      name: string;
      summary?: string;
      image?: {
        medium?: string;
        original?: string;
      } | null;
      network?: {
        name: string;
      } | null;
      webChannel?: {
        name: string;
      } | null;
      genres?: string[];
      status?: string;
      premiered?: string;
      rating?: {
        average?: number;
      } | null;
      runtime?: number;
      officialSite?: string;
      language?: string;
      type?: string;
      updated?: number;
    };
  };
}

export default function FollowedShows() {
  const { data: followedShows, isLoading, error } = useQuery({
    queryKey: ["/api/tvmaze/followed-shows"],
    queryFn: async () => {
      const response = await fetch("/api/tvmaze/followed-shows");
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid TVMaze API credentials. Please check your API key and username.");
        }
        if (response.status === 404) {
          throw new Error("Library service not available. Please check your account settings.");
        }
        throw new Error("Failed to fetch library");
      }
      return response.json() as Promise<FollowedShow[]>;
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
              {followedShows?.length || 0}
            </span>
          </div>
          <p className="text-muted-foreground text-sm">Your complete TV show collection</p>
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
        {followedShows && followedShows.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {followedShows.map((followedShow) => (
              <div
                key={followedShow.show_id}
                className="bg-card rounded-lg p-4 border border-border hover:shadow-lg transition-shadow"
                data-testid={`card-followed-show-${followedShow.show_id}`}
              >
                <div className="flex space-x-3 mb-4">
                  <div className="w-12 h-16 bg-muted rounded-md overflow-hidden flex-shrink-0">
                    {followedShow._embedded.show.image?.medium ? (
                      <img
                        src={followedShow._embedded.show.image.medium}
                        alt={followedShow._embedded.show.name}
                        className="w-full h-full object-cover"
                        data-testid={`img-poster-${followedShow.show_id}`}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-muted">
                        <Tv className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm mb-1 truncate" data-testid={`text-title-${followedShow.show_id}`}>
                      {followedShow._embedded.show.name}
                    </h3>
                    <p className="text-xs text-muted-foreground mb-2" data-testid={`text-network-${followedShow.show_id}`}>
                      {followedShow._embedded.show.network?.name || 
                       followedShow._embedded.show.webChannel?.name || 
                       "Unknown Network"}
                    </p>
                    <div className="flex items-center space-x-2">
                      {followedShow._embedded.show.status && (
                        <span className="bg-secondary text-secondary-foreground px-2 py-1 rounded text-xs" data-testid={`text-status-${followedShow.show_id}`}>
                          {followedShow._embedded.show.status}
                        </span>
                      )}
                      {followedShow._embedded.show.rating?.average && (
                        <span className="text-xs text-muted-foreground" data-testid={`text-rating-${followedShow.show_id}`}>
                          ⭐ {followedShow._embedded.show.rating.average}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                
                {/* Genres */}
                {followedShow._embedded.show.genres && followedShow._embedded.show.genres.length > 0 && (
                  <div className="mb-3">
                    <div className="flex flex-wrap gap-1">
                      {followedShow._embedded.show.genres.slice(0, 3).map((genre) => (
                        <span
                          key={genre}
                          className="bg-accent text-accent-foreground px-2 py-1 rounded-full text-xs"
                          data-testid={`text-genre-${followedShow.show_id}-${genre.toLowerCase()}`}
                        >
                          {genre}
                        </span>
                      ))}
                      {followedShow._embedded.show.genres.length > 3 && (
                        <span className="text-xs text-muted-foreground px-2 py-1">
                          +{followedShow._embedded.show.genres.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Summary */}
                {followedShow._embedded.show.summary && (
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    <div
                      className="line-clamp-3"
                      dangerouslySetInnerHTML={{
                        __html: followedShow._embedded.show.summary
                          .replace(/<[^>]*>/g, "")
                          .substring(0, 120) + (followedShow._embedded.show.summary.length > 120 ? "..." : "")
                      }}
                      data-testid={`text-summary-${followedShow.show_id}`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {followedShows && followedShows.length === 0 && !isLoading && !error && (
          <div className="text-center py-12">
            <BookOpen className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold text-muted-foreground mb-2">No shows in library</h3>
            <p className="text-muted-foreground text-sm mb-4" data-testid="text-empty-state">
              Your library is empty. Add shows to start building your collection.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}