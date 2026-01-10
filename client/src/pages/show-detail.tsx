import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Star, Calendar, Clock, Globe, Tv, Users, Monitor, Play, Hash, ExternalLink, RefreshCw, Trash2, X } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TVMazeShow } from "@/lib/tvmaze";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { UserShow, Group } from "@shared/schema";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState, useEffect, useRef } from "react";

interface ShowStats {
  totalEpisodes: number;
  seasons: number;
  lastEpisode: any;
}

interface SyncProgress {
  jobId: string | null;
  isOpen: boolean;
  status: 'queued' | 'running' | 'success' | 'error' | 'canceled';
  phase: 'fetch-show' | 'fetch-scrobbles' | 'fetch-episodes' | 'process-episodes' | 'finalize';
  percent: number;
  completedEpisodes: number;
  totalEpisodes: number;
  etaSeconds: number | null;
  message: string;
  errors: string[];
  episodesImported?: number;
  episodesUpdated?: number;
}

export default function ShowDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    jobId: null,
    isOpen: false,
    status: 'queued',
    phase: 'fetch-show',
    percent: 0,
    completedEpisodes: 0,
    totalEpisodes: 0,
    etaSeconds: null,
    message: '',
    errors: []
  });
  const eventSourceRef = useRef<EventSource | null>(null);
  
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

  const { data: episodes, isLoading: episodesLoading } = useQuery({
    queryKey: ['/api/shows', id, 'episodes'],
    queryFn: async () => {
      const response = await fetch(`/api/shows/${id}/episodes`);
      if (!response.ok) {
        throw new Error('Failed to fetch episodes');
      }
      return response.json();
    },
    enabled: !!id,
  });

  const { data: userEpisodeStatuses } = useQuery({
    queryKey: ['/api/shows', id, 'user-episodes'],
    queryFn: async () => {
      const response = await fetch(`/api/shows/${id}/user-episodes`);
      if (!response.ok) {
        throw new Error('Failed to fetch user episodes');
      }
      return response.json();
    },
    enabled: !!id,
  });

  const { data: userShow } = useQuery<UserShow>({
    queryKey: ['/api/user/shows', id],
    queryFn: async () => {
      const response = await fetch('/api/library');
      if (!response.ok) {
        throw new Error('Failed to fetch user shows');
      }
      const userShows = await response.json();
      return userShows.find((us: any) => us.show.id === parseInt(id!));
    },
    enabled: !!id,
  });

  // Remove show mutation
  const removeShowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", `/api/user/shows/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/library"] });
      toast({
        title: "Show removed",
        description: `"${show?.name}" has been removed from your library and unfollowed on TVMaze.`,
      });
      setIsRemoveDialogOpen(false);
      // Navigate back to library after removal
      setLocation("/library");
    },
    onError: (error: any) => {
      toast({
        title: "Remove failed",
        description: error.message || `Failed to remove "${show?.name}"`,
        variant: "destructive",
      });
      setIsRemoveDialogOpen(false);
    },
  });

  // Query for user's groups
  const { data: userGroups } = useQuery<Group[]>({
    queryKey: ['/api/groups'],
  });

  // Update group assignment mutation with optimistic updates
  const updateGroupMutation = useMutation({
    mutationFn: async (groupId: string | null) => {
      return apiRequest("PATCH", `/api/user/shows/${id}/group`, { groupId });
    },
    onMutate: async (groupId: string | null) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ['/api/user/shows', id] });
      await queryClient.cancelQueries({ queryKey: ['/api/library'] });

      // Snapshot the previous values for rollback
      const previousUserShow = queryClient.getQueryData(['/api/user/shows', id]);
      const previousLibrary = queryClient.getQueryData(['/api/library']);

      // Optimistically update the user show cache
      queryClient.setQueryData(['/api/user/shows', id], (old: any) => {
        if (old) {
          return { ...old, groupId, isShared: groupId !== null };
        }
        return old;
      });

      // Optimistically update the library cache
      queryClient.setQueryData(['/api/library'], (old: any) => {
        if (old && Array.isArray(old)) {
          return old.map((us: any) => 
            us?.show?.id === parseInt(id!) 
              ? { ...us, groupId, isShared: groupId !== null }
              : us
          );
        }
        return old;
      });

      return { previousUserShow, previousLibrary, groupId };
    },
    onError: (error: any, groupId: string | null, context: any) => {
      // Restore the cache from snapshots on error
      if (context?.previousUserShow !== undefined) {
        queryClient.setQueryData(['/api/user/shows', id], context.previousUserShow);
      }
      if (context?.previousLibrary !== undefined) {
        queryClient.setQueryData(['/api/library'], context.previousLibrary);
      }
      
      toast({
        title: "Update failed",
        description: error.message || `Failed to update group for "${show?.name}"`,
        variant: "destructive",
      });
    },
    onSuccess: (data: any, groupId: string | null, context: any) => {
      const groupName = groupId ? userGroups?.find(g => g.id === groupId)?.name : 'Personal';
      toast({
        title: "Group updated",
        description: `"${show?.name}" has been moved to ${groupName}.`,
      });
    },
    onSettled: () => {
      // Invalidate queries to refetch canonical state from server
      queryClient.invalidateQueries({ queryKey: ["/api/library"] });
      queryClient.invalidateQueries({ queryKey: ['/api/user/shows', id] });
      queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes/upcoming"] });
    },
  });

  const handleConfirmRemove = () => {
    removeShowMutation.mutate();
  };

  // Cleanup EventSource on unmount or job completion
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  const startSync = async () => {
    try {
      // Start async sync
      const response = await fetch(`/api/shows/${id}/sync/start`, { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to start sync');
      }
      
      const { jobId } = await response.json();
      
      setSyncProgress(prev => ({
        ...prev,
        jobId,
        isOpen: true,
        status: 'running',
        message: 'Starting sync...'
      }));

      // Connect to EventSource for real-time updates
      const eventSource = new EventSource(`/api/sync/${jobId}/events`);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'init' || data.type === 'progress') {
            setSyncProgress(prev => ({
              ...prev,
              status: data.data.status ?? prev.status,
              phase: data.data.phase ?? prev.phase,
              percent: data.data.percent ?? prev.percent,
              completedEpisodes: data.data.completedEpisodes ?? prev.completedEpisodes,
              totalEpisodes: data.data.totalEpisodes ?? prev.totalEpisodes,
              etaSeconds: data.data.etaSeconds,
              message: data.data.message ?? prev.message,
              errors: data.data.errors ?? prev.errors
            }));
          } else if (data.type === 'complete') {
            setSyncProgress(prev => ({
              ...prev,
              status: 'success',
              percent: 100,
              message: data.data.message,
              episodesImported: data.data.episodesImported,
              episodesUpdated: data.data.episodesUpdated
            }));

            // Invalidate queries
            queryClient.invalidateQueries({ queryKey: ['/api/shows', id] });
            queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'stats'] });
            queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'episodes'] });
            queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });
            queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });

            toast({
              title: "Sync Complete",
              description: data.data.message,
            });

            eventSource.close();
            eventSourceRef.current = null;
          } else if (data.type === 'error') {
            if (data.data.fatal) {
              setSyncProgress(prev => ({
                ...prev,
                status: 'error',
                message: data.data.message || 'Sync failed'
              }));
              
              toast({
                title: "Sync Failed",
                description: data.data.message || "Failed to sync show data from TVMaze",
                variant: "destructive",
              });

              eventSource.close();
              eventSourceRef.current = null;
            } else {
              // Non-fatal error, just add to errors list
              setSyncProgress(prev => ({
                ...prev,
                errors: [...prev.errors, data.data.error]
              }));
            }
          } else if (data.type === 'canceled') {
            setSyncProgress(prev => ({
              ...prev,
              status: 'canceled',
              message: 'Sync canceled'
            }));

            eventSource.close();
            eventSourceRef.current = null;
          }
        } catch (parseError) {
          console.error('Error parsing SSE message:', parseError);
        }
      };

      eventSource.onerror = () => {
        console.error('EventSource error, attempting to use polling fallback');
        eventSource.close();
        eventSourceRef.current = null;
        
        // Fallback to polling
        const pollStatus = async () => {
          try {
            const statusResponse = await fetch(`/api/sync/${jobId}/status`);
            if (statusResponse.ok) {
              const job = await statusResponse.json();
              setSyncProgress(prev => ({
                ...prev,
                status: job.status,
                phase: job.phase,
                percent: job.percent,
                completedEpisodes: job.completedEpisodes,
                totalEpisodes: job.totalEpisodes,
                etaSeconds: job.etaSeconds,
                message: job.lastMessage,
                errors: job.errors
              }));

              if (['success', 'error', 'canceled'].includes(job.status)) {
                if (job.status === 'success') {
                  queryClient.invalidateQueries({ queryKey: ['/api/shows', id] });
                  queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'stats'] });
                  queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'episodes'] });
                  queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });
                  queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
                  
                  toast({
                    title: "Sync Complete",
                    description: job.lastMessage,
                  });
                } else if (job.status === 'error') {
                  toast({
                    title: "Sync Failed",
                    description: job.lastMessage,
                    variant: "destructive",
                  });
                }
                return;
              }

              setTimeout(pollStatus, 1000);
            }
          } catch (pollError) {
            console.error('Polling error:', pollError);
          }
        };
        
        setTimeout(pollStatus, 1000);
      };

    } catch (error: any) {
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to start sync",
        variant: "destructive",
      });
    }
  };

  const cancelSync = async () => {
    if (syncProgress.jobId && eventSourceRef.current) {
      try {
        await fetch(`/api/sync/${syncProgress.jobId}`, { method: 'DELETE' });
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      } catch (error) {
        console.error('Error canceling sync:', error);
      }
    }
  };

  const closeSyncModal = () => {
    setSyncProgress(prev => ({ ...prev, isOpen: false }));
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const formatETA = (seconds: number | null): string => {
    if (!seconds || seconds <= 0) return '';
    
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
  };

  // Episode update mutation with optimistic updates
  const updateEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });

      // Snapshot the previous value for rollback
      const previousUserEpisodes = queryClient.getQueryData(['/api/shows', id, 'user-episodes']);

      // Optimistically update the user episode status
      queryClient.setQueryData(['/api/shows', id, 'user-episodes'], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          [episodeId]: {
            ...old[episodeId],
            status,
            triagedAt: new Date().toISOString(),
            ...(status === "watched" && { watchedAt: new Date().toISOString() }),
            ...(status !== "watched" && old[episodeId]?.watchedAt && { watchedAt: null })
          }
        };
      });

      // Return a context object with the snapshotted value
      return { previousUserEpisodes };
    },
    onError: (err, variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousUserEpisodes) {
        queryClient.setQueryData(['/api/shows', id, 'user-episodes'], context.previousUserEpisodes);
      }
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: () => {
      // Invalidate queries to ensure we have the latest data from server
      queryClient.invalidateQueries({ queryKey: ['/api/shows', id, 'user-episodes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/user/episodes'] });
    },
  });

  const handleEpisodeStatusToggle = (episodeId: number, currentStatus: string) => {
    // Find the episode to check if it has an airdate
    const episode = episodes?.find((ep: any) => ep.id === episodeId);
    
    // Don't allow status cycling for episodes without air dates (future unscheduled episodes)
    if (!episode?.airdate) {
      return;
    }

    // Cycle through all possible statuses: untriaged → next → later → watched → skipped → untriaged
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
        newStatus = "skipped";
        break;
      case "skipped":
        newStatus = "untriaged";
        break;
      default:
        newStatus = "next";
        break;
    }
    
    updateEpisodeMutation.mutate({ episodeId, status: newStatus });
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-muted-foreground">Loading show details...</div>
        </div>
      </div>
    );
  }

  if (error || !show) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
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
    
    if (hasSchedule && show.schedule && show.schedule.days) {
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

  const groupEpisodesBySeason = (episodes: any[]) => {
    if (!episodes) return {};
    
    const grouped = episodes.reduce((acc: Record<number, any[]>, episode: any) => {
      const season = episode.season || 0;
      if (!acc[season]) {
        acc[season] = [];
      }
      acc[season].push(episode);
      return acc;
    }, {});

    // Sort episodes within each season by episode number (reverse order - newest first)
    Object.keys(grouped).forEach(season => {
      grouped[parseInt(season)].sort((a: any, b: any) => (b.number || 0) - (a.number || 0));
    });

    return grouped;
  };

  const getEpisodeStatusBadge = (episode: any) => {
    // Don't show status badge for episodes without air dates (future unscheduled episodes)
    if (!episode.airdate) {
      return null;
    }

    // Don't show status badge for episodes that haven't aired yet
    const airDate = new Date(episode.airdate);
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset time to compare just dates
    
    if (airDate > today) {
      return null; // Episode hasn't aired yet
    }

    const episodeId = episode.id;
    
    if (!userEpisodeStatuses || !userEpisodeStatuses[episodeId]) {
      return (
        <Badge 
          className="bg-muted text-muted-foreground border border-muted-foreground/30 text-xs cursor-pointer hover:bg-blue-500/20 hover:text-blue-400 hover:border-blue-500/30 transition-colors"
          onClick={() => handleEpisodeStatusToggle(episodeId, "untriaged")}
          data-testid={`badge-episode-status-${episodeId}`}
        >
          UNWATCHED
        </Badge>
      );
    }

    const status = userEpisodeStatuses[episodeId].status;
    
    switch (status) {
      case "watched":
        return (
          <Badge 
            className="bg-green-500/20 text-green-400 border border-green-500/30 text-xs cursor-pointer hover:bg-muted hover:text-muted-foreground hover:border-muted-foreground/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            WATCHED
          </Badge>
        );
      case "skipped":
        return (
          <Badge 
            className="bg-gray-500/20 text-gray-400 border border-gray-500/30 text-xs cursor-pointer hover:bg-muted hover:text-muted-foreground hover:border-muted-foreground/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            SKIPPED
          </Badge>
        );
      case "next":
        return (
          <Badge 
            className="bg-blue-500/20 text-blue-400 border border-blue-500/30 text-xs cursor-pointer hover:bg-yellow-500/20 hover:text-yellow-400 hover:border-yellow-500/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            NEXT
          </Badge>
        );
      case "later":
        return (
          <Badge 
            className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 text-xs cursor-pointer hover:bg-green-500/20 hover:text-green-400 hover:border-green-500/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            LATER
          </Badge>
        );
      case "untriaged":
        return (
          <Badge 
            className="bg-orange-500/20 text-orange-400 border border-orange-500/30 text-xs cursor-pointer hover:bg-blue-500/20 hover:text-blue-400 hover:border-blue-500/30 transition-colors"
            onClick={() => handleEpisodeStatusToggle(episodeId, status)}
            data-testid={`badge-episode-status-${episodeId}`}
          >
            NEW
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Breadcrumb Navigation and Actions */}
        <div className="mb-6 flex items-center justify-between">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/library" data-testid="breadcrumb-library">
                    Library
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage data-testid="breadcrumb-show">
                  {show.name}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          
          <Button 
            variant="outline" 
            size="sm"
            onClick={startSync}
            disabled={syncProgress.status === 'running'}
            data-testid="button-sync-show"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncProgress.status === 'running' ? 'animate-spin' : ''}`} />
            {syncProgress.status === 'running' ? 'Syncing...' : 'Sync from TVMaze'}
          </Button>
        </div>

        {/* Sync Progress Modal */}
        <Dialog open={syncProgress.isOpen} onOpenChange={() => {}}>
          <DialogContent className="sm:max-w-[425px]" data-testid="modal-sync-progress">
            <DialogHeader>
              <DialogTitle>Syncing "{show?.name}"</DialogTitle>
              <DialogDescription>
                Importing episodes and watch status from TVMaze
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4">
              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Progress</span>
                  <span>{syncProgress.percent}%</span>
                </div>
                <Progress value={syncProgress.percent} className="w-full" data-testid="progress-sync" />
                {syncProgress.totalEpisodes > 0 && (
                  <div className="text-sm text-muted-foreground">
                    {syncProgress.completedEpisodes} of {syncProgress.totalEpisodes} episodes
                    {syncProgress.etaSeconds && (
                      <span> • ETA: {formatETA(syncProgress.etaSeconds)}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Current Phase */}
              <div className="space-y-1">
                <div className="text-sm font-medium capitalize">
                  {syncProgress.phase.replace('-', ' ')}
                </div>
                <div className="text-sm text-muted-foreground" data-testid="text-sync-message">
                  {syncProgress.message}
                </div>
              </div>

              {/* Errors */}
              {syncProgress.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-destructive">
                    {syncProgress.errors.length} Error{syncProgress.errors.length > 1 ? 's' : ''}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {syncProgress.errors[syncProgress.errors.length - 1]}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex justify-end space-x-2">
                {syncProgress.status === 'running' && (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={cancelSync}
                    data-testid="button-cancel-sync"
                  >
                    Cancel
                  </Button>
                )}
                
                {['success', 'error', 'canceled'].includes(syncProgress.status) && (
                  <Button 
                    size="sm" 
                    onClick={closeSyncModal}
                    data-testid="button-close-sync"
                  >
                    Close
                  </Button>
                )}
              </div>

              {/* Success Summary */}
              {syncProgress.status === 'success' && (
                <div className="text-sm text-muted-foreground border-t pt-4">
                  {syncProgress.episodesImported || 0} episodes imported
                  {syncProgress.episodesUpdated ? `, ${syncProgress.episodesUpdated} updated` : ''}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

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
            <div className="space-y-4">
              <div>
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-foreground break-words" data-testid={`text-show-title-${show.id}`}>
                  {show.name}
                </h1>
              </div>
              
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                {show.rating?.average && (
                  <div className="flex items-center space-x-1" data-testid={`text-show-rating-${show.id}`}>
                    <Star className="w-5 h-5 text-yellow-500" />
                    <span className="text-foreground font-medium">{formatRating(show.rating)}</span>
                  </div>
                )}
                
                <div className="flex flex-wrap gap-3">
                  {userShow && (
                    <div className="flex items-center space-x-2 bg-card border rounded-lg px-3 py-2">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <Label className="text-sm font-medium">
                        Collection
                      </Label>
                      <Select
                        value={userShow.groupId || "personal"}
                        onValueChange={(value) => updateGroupMutation.mutate(value === "personal" ? null : value)}
                        disabled={updateGroupMutation.isPending}
                      >
                        <SelectTrigger className="w-32 h-8" data-testid={`select-group-show-${id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="personal">Personal</SelectItem>
                          {userGroups?.map((group) => (
                            <SelectItem key={group.id} value={group.id}>
                              {group.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <AlertDialog open={isRemoveDialogOpen} onOpenChange={setIsRemoveDialogOpen}>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-8"
                        data-testid={`button-remove-show-${show.id}`}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        <span className="hidden sm:inline">Remove Show</span>
                        <span className="sm:hidden">Remove</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove Show</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to remove "{show.name}" from your library? This will unfollow the show on TVMaze but keep your episode data.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleConfirmRemove}
                          disabled={removeShowMutation.isPending}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {removeShowMutation.isPending ? "Removing..." : "Remove Show"}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
              {show.status && (
                <Badge className={getStatusColor(show.status)} data-testid={`badge-show-status-${show.id}`}>
                  {show.status}
                </Badge>
              )}
            </div>

            {/* Meta Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

            {/* Genres */}
            {show.genres && show.genres.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-foreground">Genres</h2>
                <div className="flex flex-wrap gap-2" data-testid={`text-show-genres-${show.id}`}>
                  {show.genres.map((genre) => (
                    <span
                      key={genre}
                      className="bg-accent text-accent-foreground px-3 py-1 rounded-full text-sm"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Episodes List */}
            {episodes && episodes.length > 0 && (
              <div className="space-y-4 mt-8">
                <h2 className="text-2xl font-semibold text-foreground">Episodes</h2>
                
                {episodesLoading ? (
                  <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                        <div className="h-6 bg-muted rounded mb-4 w-32"></div>
                        <div className="space-y-3">
                          {Array.from({ length: 5 }).map((_, j) => (
                            <div key={j} className="flex space-x-3">
                              <div className="w-16 h-12 bg-muted rounded flex-shrink-0"></div>
                              <div className="flex-1 space-y-2">
                                <div className="h-4 bg-muted rounded"></div>
                                <div className="h-3 bg-muted rounded w-3/4"></div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {Object.entries(groupEpisodesBySeason(episodes))
                      .sort(([a], [b]) => parseInt(b) - parseInt(a)) // Sort seasons in reverse order
                      .map(([season, seasonEpisodes]) => (
                        <div key={season} className="bg-card rounded-lg p-6 border border-border">
                          <h3 className="text-xl font-semibold text-foreground mb-4 border-b border-border pb-2">
                            Season {season}
                          </h3>
                          <div className="space-y-3">
                            {seasonEpisodes.map((episode: any) => (
                              <div 
                                key={episode.id} 
                                className="flex space-x-4 p-3 hover:bg-muted/50 rounded-md transition-colors"
                                data-testid={`episode-${episode.id}`}
                              >
                                <div className="w-16 h-12 bg-muted rounded overflow-hidden flex-shrink-0">
                                  {episode.image?.medium ? (
                                    <img
                                      src={episode.image.medium}
                                      alt={`Episode ${episode.number}`}
                                      className="w-full h-full object-cover"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-muted">
                                      <Play className="w-4 h-4 text-muted-foreground" />
                                    </div>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between">
                                    <div className="flex-1 min-w-0">
                                      <Link href={`/episode/${episode.id}`}>
                                        <h4 className="font-medium text-foreground truncate hover:text-primary transition-colors cursor-pointer">
                                          {episode.number ? `${episode.number}. ` : ''}{episode.name || `Episode ${episode.number}`}
                                        </h4>
                                      </Link>
                                      {episode.summary && (
                                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                          {episode.summary.replace(/<[^>]*>/g, '')}
                                        </p>
                                      )}
                                    </div>
                                    <div className="flex flex-col items-end text-sm text-muted-foreground ml-4 flex-shrink-0 space-y-1">
                                      {getEpisodeStatusBadge(episode)}
                                      {episode.airdate && (
                                        <span>{new Date(episode.airdate).toLocaleDateString('en-US')}</span>
                                      )}
                                      {episode.runtime && (
                                        <span>{episode.runtime} min</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
    </div>
  );
}