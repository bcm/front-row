import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { ArrowLeft, Star, Calendar, Clock, Globe, Tv, Users, Monitor, Play, Hash, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import Header from "@/components/header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TVMazeShow } from "@/lib/tvmaze";

interface ShowStats {
  totalEpisodes: number;
  seasons: number;
  lastEpisode: any;
}

export default function ShowDetail() {
  const { id } = useParams<{ id: string }>();
  
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
    
    if (hasSchedule) {
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

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Back Button */}
        <div className="mb-6">
          <Link href="/library">
            <Button variant="outline" size="sm" data-testid="button-back-to-library">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Library
            </Button>
          </Link>
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
              <h1 className="text-4xl font-bold text-foreground" data-testid={`text-show-title-${show.id}`}>
                {show.name}
              </h1>
              {show.status && (
                <Badge className={getStatusColor(show.status)} data-testid={`badge-show-status-${show.id}`}>
                  {show.status}
                </Badge>
              )}
            </div>

            {/* Meta Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {show.rating?.average && (
                <div className="flex items-center space-x-2" data-testid={`text-show-rating-${show.id}`}>
                  <Star className="w-5 h-5 text-yellow-500" />
                  <span className="text-foreground font-medium">{formatRating(show.rating)}</span>
                </div>
              )}

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

              {show.genres && show.genres.length > 0 && (
                <div className="flex items-center space-x-2 md:col-span-2" data-testid={`text-show-genres-${show.id}`}>
                  <Users className="w-5 h-5 text-muted-foreground" />
                  <span className="text-foreground">{formatGenres(show.genres)}</span>
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
          </div>
        </div>
      </main>
    </div>
  );
}