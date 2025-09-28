import { useState, useCallback, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AlertCircle, CheckCircle, Clock, RefreshCw, Tv } from "lucide-react";

interface EpisodeSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SyncProgress {
  status: 'running' | 'success' | 'error';
  phase: string;
  percent: number;
  completedEpisodes: number;
  totalEpisodes: number;
  etaSeconds?: number;
  message: string;
  errors: string[];
  episodesImported?: number;
  episodesUpdated?: number;
}

export default function EpisodeSyncDialog({ open, onOpenChange }: EpisodeSyncDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);

  // Import episodes mutation to start the sync process
  const syncEpisodesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/episodes/import", {});
      return response.json();
    },
    onSuccess: (data: any) => {
      // If sync completes immediately (no job created), show success
      if (!data.jobId) {
        setSyncProgress({
          status: 'success',
          phase: 'complete',
          percent: 100,
          completedEpisodes: data.imported || 0,
          totalEpisodes: data.imported || 0,
          message: 'Episode sync completed!',
          errors: [],
          episodesImported: data.imported,
          episodesUpdated: data.skipped
        });

        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/library"] });
        
        setTimeout(() => {
          toast({
            title: "Episode sync completed",
            description: `Successfully imported ${data.imported || 0} episodes, skipped ${data.skipped || 0} existing episodes.`,
          });
          onOpenChange(false);
        }, 2000);
      }
    },
    onError: (error: any) => {
      setSyncProgress({
        status: 'error',
        phase: 'error',
        percent: 0,
        completedEpisodes: 0,
        totalEpisodes: 0,
        message: 'Episode sync failed',
        errors: [error.message || 'Failed to start episode sync'],
        episodesImported: 0,
        episodesUpdated: 0
      });
      
      toast({
        title: "Episode sync failed",
        description: error.message || "Failed to start episode sync",
        variant: "destructive",
      });
    },
  });

  // Set up Server-Sent Events for real-time progress
  const setupSSE = useCallback((jobId: string) => {
    const source = new EventSource(`/api/episodes/import/progress/${jobId}`);
    setEventSource(source);

    source.onmessage = (event) => {
      try {
        const progressData = JSON.parse(event.data);
        
        if (progressData.type === 'progress' || progressData.type === 'init') {
          setSyncProgress({
            status: progressData.data.status,
            phase: progressData.data.phase || '',
            percent: progressData.data.percent || 0,
            completedEpisodes: progressData.data.completedEpisodes || 0,
            totalEpisodes: progressData.data.totalEpisodes || 0,
            etaSeconds: progressData.data.etaSeconds,
            message: progressData.data.message || '',
            errors: progressData.data.errors || [],
            episodesImported: progressData.data.episodesImported,
            episodesUpdated: progressData.data.episodesUpdated
          });
        }
        
        if (progressData.type === 'complete') {
          setSyncProgress(prev => prev ? { ...prev, status: 'success' } : null);
          
          // Invalidate queries to refresh data
          queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
          queryClient.invalidateQueries({ queryKey: ["/api/library"] });
          
          setTimeout(() => {
            const completionData = progressData.data || {};
            toast({
              title: "Episode sync completed",
              description: `Successfully imported ${completionData.episodesImported || 0} episodes, updated ${completionData.episodesUpdated || 0} existing episodes.`,
            });
            onOpenChange(false);
          }, 2000);
        }

        if (progressData.type === 'error') {
          setSyncProgress(prev => prev ? { 
            ...prev, 
            status: 'error',
            errors: [...(prev.errors || []), progressData.data.error || 'Unknown error']
          } : null);
        }
      } catch (error) {
        console.error('Error parsing SSE data:', error);
      }
    };

    source.onerror = (error) => {
      console.error('SSE error:', error);
      source.close();
      setEventSource(null);
    };

    return source;
  }, [queryClient, toast, onOpenChange]);

  // Start the episode sync process
  const handleStartSync = async () => {
    try {
      setSyncProgress({
        status: 'running',
        phase: 'starting',
        percent: 0,
        completedEpisodes: 0,
        totalEpisodes: 0,
        message: 'Starting episode sync...',
        errors: [],
      });

      const response = await apiRequest("POST", "/api/episodes/import", {});
      const data = await response.json();
      
      if (data.jobId) {
        // Job-based sync with progress tracking
        setupSSE(data.jobId);
      } else {
        // Direct sync completed immediately
        setSyncProgress({
          status: 'success',
          phase: 'complete',
          percent: 100,
          completedEpisodes: data.imported || 0,
          totalEpisodes: data.imported || 0,
          message: 'Episode sync completed!',
          errors: [],
          episodesImported: data.imported,
          episodesUpdated: data.skipped
        });

        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/library"] });
        
        setTimeout(() => {
          toast({
            title: "Episode sync completed",
            description: `Successfully imported ${data.imported || 0} episodes, skipped ${data.skipped || 0} existing episodes.`,
          });
          onOpenChange(false);
        }, 2000);
      }
    } catch (error: any) {
      setSyncProgress({
        status: 'error',
        phase: 'error',
        percent: 0,
        completedEpisodes: 0,
        totalEpisodes: 0,
        message: 'Episode sync failed',
        errors: [error.message || 'Failed to start episode sync'],
        episodesImported: 0,
        episodesUpdated: 0
      });
      
      toast({
        title: "Episode sync failed",
        description: error.message || "Failed to start episode sync",
        variant: "destructive",
      });
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [eventSource]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSyncProgress(null);
      if (eventSource) {
        eventSource.close();
        setEventSource(null);
      }
    }
  }, [open, eventSource]);

  const getPhaseIcon = (phase: string) => {
    switch (phase) {
      case 'fetch-episodes':
        return <Tv className="w-4 h-4" />;
      case 'process-episodes':
        return <RefreshCw className="w-4 h-4" />;
      case 'finalize':
        return <CheckCircle className="w-4 h-4" />;
      default:
        return <Clock className="w-4 h-4" />;
    }
  };

  const getPhaseDescription = (phase: string) => {
    switch (phase) {
      case 'fetch-episodes':
        return 'Fetching latest episode data from TVMaze...';
      case 'process-episodes':
        return 'Processing and updating episode information...';
      case 'finalize':
        return 'Finalizing episode sync...';
      default:
        return 'Preparing episode sync...';
    }
  };

  const formatETA = (seconds?: number) => {
    if (!seconds) return null;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    return `${Math.round(seconds / 60)}m`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            Episode Sync
          </DialogTitle>
          <DialogDescription>
            Update episode data for all shows in your library from TVMaze. This will fetch the latest 
            episode information, air dates, and metadata for existing shows without changing your watch progress.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {!syncProgress && (
            <div className="space-y-4">
              <div className="bg-muted/50 p-4 rounded-lg space-y-3">
                <h4 className="font-medium text-sm">What this does:</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Updates episode data for shows already in your library</li>
                  <li>• Fetches latest air dates, episode names, and summaries</li>
                  <li>• Adds newly aired episodes to your tracking</li>
                  <li>• Preserves your existing watch progress</li>
                </ul>
              </div>
              
              <div className="bg-blue-50 dark:bg-blue-950/20 p-4 rounded-lg">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <strong>Note:</strong> This only updates shows already in your library. 
                  To add new shows, use "Import New Shows" instead.
                </p>
              </div>
            </div>
          )}

          {syncProgress && (
            <div className="space-y-4">
              {/* Status Badge */}
              <div className="flex items-center justify-between">
                <Badge variant={syncProgress.status === 'error' ? 'destructive' : 'default'}>
                  {syncProgress.status === 'running' && <RefreshCw className="w-3 h-3 mr-1 animate-spin" />}
                  {syncProgress.status === 'success' && <CheckCircle className="w-3 h-3 mr-1" />}
                  {syncProgress.status === 'error' && <AlertCircle className="w-3 h-3 mr-1" />}
                  {syncProgress.status === 'running' ? 'Syncing' : 
                   syncProgress.status === 'success' ? 'Complete' : 'Failed'}
                </Badge>
                {syncProgress.etaSeconds && (
                  <span className="text-xs text-muted-foreground">
                    ETA: {formatETA(syncProgress.etaSeconds)}
                  </span>
                )}
              </div>

              {/* Current Phase */}
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                {getPhaseIcon(syncProgress.phase)}
                <div className="flex-1">
                  <p className="text-sm font-medium">{getPhaseDescription(syncProgress.phase)}</p>
                </div>
              </div>

              {/* Progress Bar */}
              {syncProgress.status === 'running' && (
                <div className="space-y-2">
                  <Progress 
                    value={syncProgress.percent} 
                    className="w-full" 
                    data-testid="progress-episode-sync"
                  />
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>{syncProgress.message}</span>
                    <span>
                      {syncProgress.completedEpisodes} / {syncProgress.totalEpisodes} episodes
                    </span>
                  </div>
                </div>
              )}

              {/* Errors */}
              {syncProgress.errors && syncProgress.errors.length > 0 && (
                <div className="space-y-2">
                  <Separator />
                  <div className="text-sm">
                    <h4 className="font-medium text-destructive mb-2">Issues encountered:</h4>
                    <ul className="text-muted-foreground space-y-1">
                      {syncProgress.errors.map((error, index) => (
                        <li key={index} className="text-xs">• {error}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Success Summary */}
              {syncProgress.status === 'success' && (
                <div className="text-sm text-muted-foreground border-t pt-4">
                  {syncProgress.episodesImported || 0} episodes imported
                  {syncProgress.episodesUpdated ? `, ${syncProgress.episodesUpdated} updated` : ''}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {!syncProgress ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleStartSync}
                disabled={syncEpisodesMutation.isPending}
                data-testid="button-start-episode-sync"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Start Episode Sync
              </Button>
            </>
          ) : (
            <Button 
              onClick={() => onOpenChange(false)}
              disabled={syncProgress.status === 'running'}
              data-testid="button-close-episode-sync"
            >
              {syncProgress.status === 'running' ? 'Syncing...' : 'Close'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}