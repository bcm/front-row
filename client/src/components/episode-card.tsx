import { UserEpisode, Episode, Show } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, Clock, Eye, ArrowRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

interface EpisodeCardProps {
  userEpisode: UserEpisode & { episode: Episode & { show: Show } };
  onStatusChange: (episodeId: number, status: string) => void;
  variant?: "default" | "compact" | "priority" | "wide";
}

export default function EpisodeCard({ userEpisode, onStatusChange, variant = "default" }: EpisodeCardProps) {
  const { episode } = userEpisode;
  const { show } = episode;

  const getStatusBadge = (status: string, variant?: string) => {
    switch (status) {
      case "untriaged":
      case "next":
      case "later":
        return null; // Don't show badges for untriaged, next, or later episodes
      case "watched":
        return <Badge className="bg-purple-500/20 text-purple-400 border border-purple-500/30">WATCHED</Badge>;
      case "skipped":
        return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30">SKIPPED</Badge>;
      default:
        return <Badge className="bg-gray-500/20 text-gray-400 border border-gray-500/30">{status}</Badge>;
    }
  };

  const formatAirdate = (airdate: string | null) => {
    if (!airdate) return "Unknown";
    return new Date(airdate).toLocaleDateString();
  };

  const getEpisodeTitle = () => {
    const seasonEpisode = getSeasonEpisodeFormat();
    if (episode.name) {
      return seasonEpisode ? `${seasonEpisode}: ${episode.name}` : episode.name;
    }
    return seasonEpisode || `Season ${episode.season}, Episode ${episode.number}`;
  };

  const getSeasonEpisodeFormat = () => {
    if (episode.season && episode.number) {
      return `${episode.season}x${episode.number}`;
    }
    return null;
  };

  if (variant === "wide") {
    return (
      <div className="episode-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200" data-testid={`card-episode-${episode.id}`}>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          {/* Image */}
          <img 
            src={episode.image?.medium || show.image?.medium || "/placeholder-show.jpg"}
            alt={`${show.name} poster`}
            className="w-full sm:w-32 h-48 sm:h-24 object-cover rounded-md flex-shrink-0"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.src = "https://via.placeholder.com/200x150/374151/9ca3af?text=" + encodeURIComponent(show.name);
            }}
          />
          
          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg truncate text-foreground mb-1" data-testid={`text-episode-title-${episode.id}`}>
              {getEpisodeTitle()}
            </h3>
            {episode.summary && (
              <p className="text-sm text-muted-foreground line-clamp-2 mb-3" data-testid={`text-episode-summary-${episode.id}`}>
                {episode.summary.replace(/<[^>]*>/g, '')}
              </p>
            )}
          </div>
          
          {/* Airdate, Runtime and Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-shrink-0">
            <div className="space-y-1 text-sm text-muted-foreground">
              <div className="flex items-center space-x-1">
                <Calendar className="w-4 h-4" />
                <span>{formatAirdate(episode.airdate)}</span>
              </div>
              {episode.runtime && (
                <div className="flex items-center space-x-1">
                  <Clock className="w-4 h-4" />
                  <span>{episode.runtime} min</span>
                </div>
              )}
            </div>
            
            <div className="flex flex-wrap gap-2">
              {getStatusBadge(userEpisode.status, variant) && getStatusBadge(userEpisode.status, variant)}
              {userEpisode.status !== "next" && (
                <Button 
                  size="sm" 
                  onClick={() => onStatusChange(episode.id, "next")}
                  data-testid={`button-next-${episode.id}`}
                >
                  <ArrowRight className="w-4 h-4 mr-1" />
                  Watch Next
                </Button>
              )}
              {userEpisode.status !== "later" && (
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={() => onStatusChange(episode.id, "later")}
                  data-testid={`button-later-${episode.id}`}
                >
                  Later
                </Button>
              )}
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => onStatusChange(episode.id, "watched")}
                data-testid={`button-watched-${episode.id}`}
              >
                <Eye className="w-4 h-4 mr-1" />
                Watched
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className="episode-card bg-card hover:bg-card/80 rounded-lg p-3 transition-all duration-200 cursor-pointer" data-testid={`card-episode-${episode.id}`}>
        <div className="flex space-x-2 mb-2">
          <img 
            src={episode.image?.medium || show.image?.medium || "/placeholder-show.jpg"}
            alt={`${show.name} poster`}
            className="w-16 h-12 object-cover rounded-md flex-shrink-0"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.src = "https://via.placeholder.com/100x75/374151/9ca3af?text=" + encodeURIComponent(show.name);
            }}
          />
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-xs truncate text-foreground" data-testid={`text-episode-title-${episode.id}`}>
              {getEpisodeTitle()}
            </h4>
            {episode.summary && (
              <p className="text-xs text-muted-foreground line-clamp-1 mt-1" data-testid={`text-episode-summary-${episode.id}`}>
                {episode.summary.replace(/<[^>]*>/g, '')}
              </p>
            )}
          </div>
        </div>
        
        <div className="space-y-1 text-xs text-muted-foreground mb-1">
          <div className="flex items-center space-x-1">
            <Calendar className="w-3 h-3" />
            <span>{formatAirdate(episode.airdate)}</span>
          </div>
          {episode.runtime && (
            <div className="flex items-center space-x-1">
              <Clock className="w-3 h-3" />
              <span>{episode.runtime}m</span>
            </div>
          )}
        </div>
        
        {getStatusBadge(userEpisode.status, variant) && getStatusBadge(userEpisode.status, variant)}
      </div>
    );
  }

  if (variant === "priority") {
    return (
      <div 
        className="episode-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200 cursor-pointer border-l-4 border-green-500"
        data-testid={`card-episode-${episode.id}`}
      >
        <div className="flex space-x-3 mb-3">
          <img 
            src={episode.image?.medium || show.image?.medium || "/placeholder-show.jpg"}
            alt={`${show.name} poster`}
            className="w-24 h-18 object-cover rounded-md flex-shrink-0"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.src = "https://via.placeholder.com/150x112/374151/9ca3af?text=" + encodeURIComponent(show.name);
            }}
          />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm truncate text-foreground mb-1" data-testid={`text-episode-title-${episode.id}`}>
              {getEpisodeTitle()}
            </h3>
            {episode.summary && (
              <p className="text-xs text-muted-foreground line-clamp-2" data-testid={`text-episode-summary-${episode.id}`}>
                {episode.summary.replace(/<[^>]*>/g, '')}
              </p>
            )}
          </div>
        </div>
        
        <div className="flex items-center justify-between">
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex items-center space-x-1">
              <Calendar className="w-3 h-3" />
              <span>{formatAirdate(episode.airdate)}</span>
            </div>
            {episode.runtime && (
              <div className="flex items-center space-x-1">
                <Clock className="w-3 h-3" />
                <span>{episode.runtime}m</span>
              </div>
            )}
          </div>
          <div className="flex space-x-1">
            <Button 
              size="sm" 
              onClick={() => onStatusChange(episode.id, "watched")}
              data-testid={`button-watched-${episode.id}`}
            >
              <Eye className="w-3 h-3 mr-1" />
              Watched
            </Button>
            <Button 
              size="sm" 
              variant="outline"
              onClick={() => onStatusChange(episode.id, "later")}
              data-testid={`button-later-${episode.id}`}
            >
              Later
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Default variant
  return (
    <div className="episode-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200" data-testid={`card-episode-${episode.id}`}>
      <div className="flex space-x-3 mb-3">
        <img 
          src={episode.image?.medium || show.image?.medium || "/placeholder-show.jpg"}
          alt={`${show.name} poster`}
          className="w-32 h-24 object-cover rounded-md flex-shrink-0"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = "https://via.placeholder.com/200x150/374151/9ca3af?text=" + encodeURIComponent(show.name);
          }}
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg truncate text-foreground mb-1" data-testid={`text-episode-title-${episode.id}`}>
            {getEpisodeTitle()}
          </h3>
          {episode.summary && (
            <p className="text-sm text-muted-foreground line-clamp-2" data-testid={`text-episode-summary-${episode.id}`}>
              {episode.summary.replace(/<[^>]*>/g, '')}
            </p>
          )}
        </div>
      </div>
      
      <div className="space-y-1 text-sm text-muted-foreground mb-2">
        <div className="flex items-center space-x-1">
          <Calendar className="w-4 h-4" />
          <span>{formatAirdate(episode.airdate)}</span>
        </div>
        {episode.runtime && (
          <div className="flex items-center space-x-1">
            <Clock className="w-4 h-4" />
            <span>{episode.runtime} min</span>
          </div>
        )}
      </div>
      
      <div className="flex items-center justify-between">
        <div>{getStatusBadge(userEpisode.status, variant)}</div>
        <div className="flex space-x-2">
          <Button 
            size="sm" 
            onClick={() => onStatusChange(episode.id, "next")}
            data-testid={`button-next-${episode.id}`}
          >
            <ArrowRight className="w-4 h-4 mr-1" />
            Watch Next
          </Button>
          <Button 
            size="sm" 
            variant="outline"
            onClick={() => onStatusChange(episode.id, "later")}
            data-testid={`button-later-${episode.id}`}
          >
            Later
          </Button>
          <Button 
            size="sm" 
            variant="outline"
            onClick={() => onStatusChange(episode.id, "watched")}
            data-testid={`button-watched-${episode.id}`}
          >
            <Eye className="w-4 h-4 mr-1" />
            Watched
          </Button>
        </div>
      </div>
    </div>
  );
}