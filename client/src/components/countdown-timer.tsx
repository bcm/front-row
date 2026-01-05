import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Timer, Tv, Calendar } from "lucide-react";
import { Link } from "wouter";
import type { Episode, Show } from "@shared/schema";

interface UpcomingEpisode extends Episode {
  show: Show;
}

function formatCountdown(targetDate: Date): { text: string; urgent: boolean } {
  const now = new Date();
  const diff = targetDate.getTime() - now.getTime();
  
  if (diff <= 0) {
    return { text: "Airing now!", urgent: true };
  }
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  
  if (days > 0) {
    return { text: `${days}d ${hours}h ${minutes}m`, urgent: false };
  } else if (hours > 0) {
    return { text: `${hours}h ${minutes}m ${seconds}s`, urgent: hours < 2 };
  } else {
    return { text: `${minutes}m ${seconds}s`, urgent: true };
  }
}

interface ScheduleInfo {
  time?: string;
  days?: string[];
}

function CountdownDisplay({ airdate, schedule }: { airdate: string; schedule?: ScheduleInfo | null }) {
  const [countdown, setCountdown] = useState<{ text: string; urgent: boolean }>({ text: "", urgent: false });
  
  useEffect(() => {
    let airTime = "00:00";
    if (schedule?.time && /^\d{2}:\d{2}$/.test(schedule.time)) {
      airTime = schedule.time;
    }
    const targetDate = new Date(`${airdate}T${airTime}:00`);
    
    const update = () => {
      setCountdown(formatCountdown(targetDate));
    };
    
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [airdate, schedule]);
  
  return (
    <span className={`font-mono text-sm ${countdown.urgent ? "text-orange-500 dark:text-orange-400" : "text-muted-foreground"}`}>
      {countdown.text}
    </span>
  );
}

interface CountdownTimerProps {
  showMode?: string;
}

export default function CountdownTimer({ showMode = 'personal' }: CountdownTimerProps) {
  const { data: upcomingEpisodes, isLoading } = useQuery<UpcomingEpisode[]>({
    queryKey: ["/api/user/episodes/upcoming", showMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (showMode) {
        params.set('showMode', showMode);
      }
      const response = await fetch(`/api/user/episodes/upcoming?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch upcoming episodes");
      return response.json();
    },
    refetchInterval: 60000,
  });

  const nextEpisodesByShow = useMemo(() => {
    if (!upcomingEpisodes || upcomingEpisodes.length === 0) return [];
    
    const isEarlier = (a: UpcomingEpisode, b: UpcomingEpisode): boolean => {
      if (!a.airdate) return false;
      if (!b.airdate) return true;
      if (a.airdate < b.airdate) return true;
      if (a.airdate > b.airdate) return false;
      if ((a.season || 0) < (b.season || 0)) return true;
      if ((a.season || 0) > (b.season || 0)) return false;
      return (a.number || 0) < (b.number || 0);
    };
    
    const showMap = new Map<number, UpcomingEpisode>();
    
    upcomingEpisodes.forEach(episode => {
      const showId = episode.show.id;
      const existing = showMap.get(showId);
      
      if (!existing || isEarlier(episode, existing)) {
        showMap.set(showId, episode);
      }
    });
    
    return Array.from(showMap.values()).sort((a, b) => {
      if (!a.airdate || !b.airdate) return 0;
      if (a.airdate !== b.airdate) return a.airdate.localeCompare(b.airdate);
      if ((a.season || 0) !== (b.season || 0)) return (a.season || 0) - (b.season || 0);
      return (a.number || 0) - (b.number || 0);
    });
  }, [upcomingEpisodes]);

  if (isLoading) {
    return (
      <section>
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center">
            <Timer className="w-4 h-4 text-white" />
          </div>
          <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate">Upcoming Episodes</h2>
        </div>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="w-full sm:w-32 h-48 sm:h-24 bg-muted rounded-md flex-shrink-0"></div>
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-muted rounded"></div>
                  <div className="h-3 bg-muted rounded w-3/4"></div>
                  <div className="h-3 bg-muted rounded w-1/2"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (nextEpisodesByShow.length === 0) {
    return (
      <section>
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center">
            <Timer className="w-4 h-4 text-white" />
          </div>
          <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-countdown">Upcoming Episodes</h2>
          <p className="hidden sm:inline text-muted-foreground text-base ml-4 shrink-0">Countdown to new episodes</p>
        </div>
        <div className="text-center py-8">
          <Timer className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold text-muted-foreground mb-2">No upcoming episodes</h3>
          <p className="text-muted-foreground">Episodes will appear here when they have scheduled air dates</p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="section-countdown-timer">
      <div className="flex items-center space-x-3 mb-6">
        <div className="w-6 h-6 bg-orange-500 rounded-full flex items-center justify-center">
          <Timer className="w-4 h-4 text-white" />
        </div>
        <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-countdown">Upcoming Episodes</h2>
        <p className="hidden sm:inline text-muted-foreground text-base ml-4 shrink-0">Countdown to new episodes</p>
      </div>
      
      <div className="space-y-4">
        {nextEpisodesByShow.map((episode) => (
          <div 
            key={episode.id} 
            className="bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200"
            data-testid={`countdown-episode-${episode.id}`}
          >
            <div className="flex flex-col sm:flex-row sm:items-start gap-4">
              {episode.show.image?.medium ? (
                <img 
                  src={episode.show.image.medium} 
                  alt={episode.show.name}
                  className="w-full sm:w-32 h-48 sm:h-24 object-cover rounded-md flex-shrink-0"
                />
              ) : (
                <div className="w-full sm:w-32 h-48 sm:h-24 bg-muted rounded-md flex items-center justify-center flex-shrink-0">
                  <Tv className="h-8 w-8 text-muted-foreground" />
                </div>
              )}
              
              <div className="flex-1 min-w-0">
                <Link href={`/show/${episode.show.id}`}>
                  <h3 className="font-bold text-lg text-primary hover:text-primary/80 truncate mb-1" data-testid={`text-show-name-${episode.id}`}>
                    {episode.show.name}
                    {(episode.show.network?.name || episode.show.webChannel?.name) && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded">
                        {episode.show.network?.name || episode.show.webChannel?.name}
                      </span>
                    )}
                  </h3>
                </Link>
                <Link href={`/episode/${episode.id}`}>
                  <p className="font-medium text-sm truncate text-muted-foreground mb-1 hover:text-foreground transition-colors cursor-pointer">
                    {episode.season}x{episode.number}: {episode.name}
                  </p>
                </Link>
                {episode.summary && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                    {episode.summary.replace(/<[^>]*>/g, '')}
                  </p>
                )}
              </div>
              
              <div className="flex flex-col sm:flex-row sm:items-start gap-4 flex-shrink-0">
                <div className="space-y-1 text-sm text-muted-foreground">
                  <div className="flex items-center space-x-1">
                    <Calendar className="w-4 h-4" />
                    <span>{new Date(episode.airdate!).toLocaleDateString('en-US')}</span>
                  </div>
                  {episode.airdate && (
                    <div className="flex items-center space-x-1">
                      <Timer className="w-4 h-4" />
                      <CountdownDisplay airdate={episode.airdate} schedule={episode.show.schedule} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
