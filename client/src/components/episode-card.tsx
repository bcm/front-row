import { UserEpisode, Episode, Show } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar, Clock, Eye, ArrowRight, MoreHorizontal, X } from "lucide-react";
import { Link } from "wouter";
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
    return new Date(airdate).toLocaleDateString('en-US');
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

  if (variant === "wide") {
    return (
      <div className="episode-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200" data-testid={`card-episode-${episode.id}`}>
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
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
            <Link href={`/show/${show.id}`}>
              <h2 className="font-bold text-lg text-primary hover:text-primary/80 truncate mb-1" data-testid={`text-show-name-${episode.id}`}>
                {show.name}
              </h2>
            </Link>
            <Link href={`/episode/${episode.id}`}>
              <h3 className="font-medium text-sm truncate text-muted-foreground mb-1 hover:text-foreground transition-colors cursor-pointer" data-testid={`text-episode-title-${episode.id}`}>
                {getEpisodeTitle()}
              </h3>
            </Link>
            {episode.summary && (
              <p className="text-sm text-muted-foreground line-clamp-2 mb-3" data-testid={`text-episode-summary-${episode.id}`}>
                {episode.summary.replace(/<[^>]*>/g, '')}
              </p>
            )}
          </div>
          
          {/* Airdate, Runtime and Actions */}
          <div className="flex flex-col sm:flex-row sm:items-start gap-4 flex-shrink-0">
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
                <ButtonWithTooltip 
                  size="sm" 
                  onClick={() => onStatusChange(episode.id, "next")}
                  data-testid={`button-next-${episode.id}`}
                  tooltip="Watch Next"
                >
                  <ArrowRight className="w-4 h-4 lg:mr-0 mr-1" />
                  <span className="lg:hidden">Watch Next</span>
                </ButtonWithTooltip>
              )}
              {userEpisode.status !== "later" && (
                <ButtonWithTooltip 
                  size="sm" 
                  variant="outline"
                  onClick={() => onStatusChange(episode.id, "later")}
                  data-testid={`button-later-${episode.id}`}
                  tooltip="Later"
                >
                  <MoreHorizontal className="w-4 h-4 lg:mr-0 mr-1 lg:block hidden" />
                  <span className="lg:hidden">Later</span>
                </ButtonWithTooltip>
              )}
              <ButtonWithTooltip 
                size="sm" 
                variant="outline"
                onClick={() => onStatusChange(episode.id, "watched")}
                data-testid={`button-watched-${episode.id}`}
                tooltip="Watched"
              >
                <Eye className="w-4 h-4 lg:mr-0 mr-1" />
                <span className="lg:hidden">Watched</span>
              </ButtonWithTooltip>
              <ButtonWithTooltip 
                size="sm" 
                variant="outline"
                onClick={() => onStatusChange(episode.id, "skipped")}
                data-testid={`button-skip-${episode.id}`}
                tooltip="Skip"
              >
                <X className="w-4 h-4 lg:mr-0 mr-1" />
                <span className="lg:hidden">Skip</span>
              </ButtonWithTooltip>
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
            <Link href={`/show/${show.id}`}>
              <h3 className="font-semibold text-sm text-primary hover:text-primary/80 truncate mb-1" data-testid={`text-show-name-${episode.id}`}>
                {show.name}
              </h3>
            </Link>
            <Link href={`/episode/${episode.id}`}>
              <h4 className="font-medium text-xs truncate text-muted-foreground hover:text-foreground transition-colors cursor-pointer" data-testid={`text-episode-title-${episode.id}`}>
                {getEpisodeTitle()}
              </h4>
            </Link>
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
            <Link href={`/show/${show.id}`}>
              <h2 className="font-bold text-base text-primary hover:text-primary/80 truncate mb-1" data-testid={`text-show-name-${episode.id}`}>
                {show.name}
              </h2>
            </Link>
            <Link href={`/episode/${episode.id}`}>
              <h3 className="font-medium text-sm truncate text-muted-foreground mb-1 hover:text-foreground transition-colors cursor-pointer" data-testid={`text-episode-title-${episode.id}`}>
                {getEpisodeTitle()}
              </h3>
            </Link>
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
            <ButtonWithTooltip 
              size="sm" 
              onClick={() => onStatusChange(episode.id, "watched")}
              data-testid={`button-watched-${episode.id}`}
              tooltip="Watched"
            >
              <Eye className="w-3 h-3 lg:mr-0 mr-1" />
              <span className="lg:hidden">Watched</span>
            </ButtonWithTooltip>
            <ButtonWithTooltip 
              size="sm" 
              variant="outline"
              onClick={() => onStatusChange(episode.id, "later")}
              data-testid={`button-later-${episode.id}`}
              tooltip="Later"
            >
              <MoreHorizontal className="w-3 h-3 lg:mr-0 mr-1 lg:block hidden" />
              <span className="lg:hidden">Later</span>
            </ButtonWithTooltip>
            <ButtonWithTooltip 
              size="sm" 
              variant="outline"
              onClick={() => onStatusChange(episode.id, "skipped")}
              data-testid={`button-skip-${episode.id}`}
              tooltip="Skip"
            >
              <X className="w-3 h-3 lg:mr-0 mr-1" />
              <span className="lg:hidden">Skip</span>
            </ButtonWithTooltip>
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
          <Link href={`/show/${show.id}`}>
            <h2 className="font-bold text-lg text-primary hover:text-primary/80 truncate mb-1" data-testid={`text-show-name-${episode.id}`}>
              {show.name}
            </h2>
          </Link>
          <Link href={`/episode/${episode.id}`}>
            <h3 className="font-medium text-base truncate text-muted-foreground mb-1 hover:text-foreground transition-colors cursor-pointer" data-testid={`text-episode-title-${episode.id}`}>
              {getEpisodeTitle()}
            </h3>
          </Link>
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
          <ButtonWithTooltip 
            size="sm" 
            onClick={() => onStatusChange(episode.id, "next")}
            data-testid={`button-next-${episode.id}`}
            tooltip="Watch Next"
          >
            <ArrowRight className="w-4 h-4 lg:mr-0 mr-1" />
            <span className="lg:hidden">Watch Next</span>
          </ButtonWithTooltip>
          <ButtonWithTooltip 
            size="sm" 
            variant="outline"
            onClick={() => onStatusChange(episode.id, "later")}
            data-testid={`button-later-${episode.id}`}
            tooltip="Later"
          >
            <MoreHorizontal className="w-4 h-4 lg:mr-0 mr-1 lg:block hidden" />
            <span className="lg:hidden">Later</span>
          </ButtonWithTooltip>
          <ButtonWithTooltip 
            size="sm" 
            variant="outline"
            onClick={() => onStatusChange(episode.id, "watched")}
            data-testid={`button-watched-${episode.id}`}
            tooltip="Watched"
          >
            <Eye className="w-4 h-4 lg:mr-0 mr-1" />
            <span className="lg:hidden">Watched</span>
          </ButtonWithTooltip>
          <ButtonWithTooltip 
            size="sm" 
            variant="outline"
            onClick={() => onStatusChange(episode.id, "skipped")}
            data-testid={`button-skip-${episode.id}`}
            tooltip="Skip"
          >
            <X className="w-4 h-4 lg:mr-0 mr-1" />
            <span className="lg:hidden">Skip</span>
          </ButtonWithTooltip>
        </div>
      </div>
    </div>
  );
}