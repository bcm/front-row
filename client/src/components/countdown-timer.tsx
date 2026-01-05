import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Tv, Calendar } from "lucide-react";
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
    
    const showMap = new Map<number, UpcomingEpisode>();
    
    upcomingEpisodes.forEach(episode => {
      const showId = episode.show.id;
      const existing = showMap.get(showId);
      
      if (!existing) {
        showMap.set(showId, episode);
      } else {
        // Replace if: new episode has a date and (existing has no date OR new is earlier)
        if (episode.airdate && (!existing.airdate || episode.airdate < existing.airdate)) {
          showMap.set(showId, episode);
        }
      }
    });
    
    return Array.from(showMap.values()).sort((a, b) => {
      if (!a.airdate || !b.airdate) return 0;
      return a.airdate.localeCompare(b.airdate);
    });
  }, [upcomingEpisodes]);

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <h3 className="font-semibold">Upcoming Episodes</h3>
        </div>
        <div className="text-sm text-muted-foreground">Loading...</div>
      </Card>
    );
  }

  if (nextEpisodesByShow.length === 0) {
    return null;
  }

  return (
    <Card className="p-4" data-testid="card-countdown-timer">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="h-5 w-5 text-primary" />
        <h3 className="font-semibold" data-testid="heading-countdown">Upcoming Episodes</h3>
        <Badge variant="secondary" className="ml-auto">{nextEpisodesByShow.length}</Badge>
      </div>
      
      <div className="space-y-3">
        {nextEpisodesByShow.map((episode) => (
          <div 
            key={episode.id} 
            className="flex items-center gap-3 p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
            data-testid={`countdown-episode-${episode.id}`}
          >
            {episode.show.image?.medium ? (
              <img 
                src={episode.show.image.medium} 
                alt={episode.show.name}
                className="w-10 h-14 object-cover rounded"
              />
            ) : (
              <div className="w-10 h-14 bg-muted rounded flex items-center justify-center">
                <Tv className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
            
            <div className="flex-1 min-w-0">
              <Link href={`/show/${episode.show.id}`}>
                <span className="font-medium text-sm hover:underline cursor-pointer line-clamp-1" data-testid={`text-show-name-${episode.id}`}>
                  {episode.show.name}
                </span>
              </Link>
              <Link href={`/episode/${episode.id}`}>
                <div className="text-xs text-muted-foreground hover:underline cursor-pointer">
                  S{String(episode.season).padStart(2, '0')}E{String(episode.number).padStart(2, '0')}: {episode.name}
                </div>
              </Link>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                <Calendar className="h-3 w-3" />
                <span>{new Date(episode.airdate + "T12:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              </div>
            </div>
            
            <div className="text-right">
              {episode.airdate && (
                <CountdownDisplay airdate={episode.airdate} schedule={episode.show.schedule} />
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
