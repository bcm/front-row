import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  existingJobId?: string;
}

interface SyncProgress {
  status: 'running' | 'success' | 'error';
  phase: string;
  percent: number;
  completedShows: number;
  totalShows: number;
  etaSeconds?: number;
  message: string;
  errors: string[];
  episodesImported?: number;
  episodesUpdated?: number;
}

export default function EpisodeSyncDialog({ open, onOpenChange, existingJobId }: EpisodeSyncDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);

  // Set jobId when dialog opens with an existing job
  useEffect(() => {
    if (open && existingJobId) {
      setJobId(existingJobId);
    } else if (!open) {
      // Reset jobId when dialog closes
      setJobId(null);
    }
  }, [open, existingJobId]);

  // Import episodes mutation to start the sync process
  const syncEpisodesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/episodes/import", {});
      return response.json();
    },
    onSuccess: (data: any) => {
      // If sync completes immediately (no job created), show success
      if (!data.jobId) {
        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/library"] });
        
        setTimeout(() => {
          toast({
            title: "Episode sync completed",
            description: `Successfully imported ${data.imported || 0} episodes, skipped ${data.skipped || 0} existing episodes.`,
          });
          onOpenChange(false);
        }, 2000);
      } else {
        // Store jobId to start polling
        setJobId(data.jobId);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Episode sync failed",
        description: error.message || "Failed to start episode sync",
        variant: "destructive",
      });
    },
  });

  // Cancel sync mutation
  const cancelSyncMutation = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error("No job to cancel");
      const response = await apiRequest("POST", `/api/episodes/import/cancel/${jobId}`, {});
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Episode sync canceled",
        description: "The sync has been stopped.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/library"] });
      onOpenChange(false);
    },
    onError: (error: any) => {
      toast({
        title: "Failed to cancel",
        description: error.message || "Could not cancel the sync",
        variant: "destructive",
      });
    },
  });

  // Polling-based progress tracking using React Query
  const { data: syncProgress, error: progressError } = useQuery({
    queryKey: ['/api/episodes/import/progress', jobId],
    queryFn: async () => {
      if (!jobId) return null;
      
      const response = await fetch(`/api/episodes/import/progress/${jobId}`, {
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch progress');
      }
      
      const data = await response.json();
      
      // Handle completion
      if (data.status === 'success') {
        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/library"] });
        
        setTimeout(() => {
          toast({
            title: "Episode sync completed",
            description: `Successfully imported ${data.episodesImported || 0} episodes, updated ${data.episodesUpdated || 0} existing episodes.`,
          });
          onOpenChange(false);
        }, 2000);
      }
      
      return {
        status: data.status,
        phase: data.phase || '',
        percent: data.percent || 0,
        completedShows: data.completedShows || 0,
        totalShows: data.totalShows || 0,
        etaSeconds: data.etaSeconds,
        message: data.message || '',
        errors: data.errors || [],
        episodesImported: data.episodesImported,
        episodesUpdated: data.episodesUpdated
      } as SyncProgress;
    },
    enabled: !!jobId && open,
    refetchInterval: 2500, // Poll every 2.5 seconds
    refetchIntervalInBackground: false,
    retry: 3,
  });

  // Start the episode sync process
  const handleStartSync = () => {
    syncEpisodesMutation.mutate();
  };

  // Reset job state when dialog closes
  useEffect(() => {
    if (!open) {
      setJobId(null);
    }
  }, [open]);

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
      <DialogContent className="sm:max-w-2xl">
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
                      {syncProgress.completedShows} / {syncProgress.totalShows} shows ({syncProgress.percent}%)
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
          ) : syncProgress.status === 'running' ? (
            <>
              <Button 
                variant="outline" 
                onClick={() => cancelSyncMutation.mutate()}
                disabled={cancelSyncMutation.isPending}
                data-testid="button-cancel-episode-sync"
              >
                Cancel Sync
              </Button>
            </>
          ) : (
            <Button 
              onClick={() => onOpenChange(false)}
              data-testid="button-close-episode-sync"
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}