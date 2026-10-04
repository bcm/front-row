import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, AlertCircle, Download } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

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

interface LibraryImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function LibraryImportDialog({ open, onOpenChange }: LibraryImportDialogProps) {
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  // Set when the poll loop gives up after repeated transient failures. The
  // dialog stays open on the last known progress and the job ID is kept, so
  // the user cannot start a duplicate import from this dialog.
  const [pollingGaveUp, setPollingGaveUp] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const importMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/library/import", {});
      return response.json();
    },
    onSuccess: (data: any) => {
      // If we get a job ID, start progress tracking
      if (data.jobId) {
        setCurrentJobId(data.jobId);
        startProgressTracking(data.jobId);
        
        toast({
          title: "Import started",
          description: data.message || "Importing your followed shows from TVMaze...",
        });
      } else {
        // Fallback for synchronous response
        queryClient.invalidateQueries({ queryKey: ["/api/library"] });
        
        toast({
          title: "Import completed",
          description: `Imported ${data.imported} shows, skipped ${data.skipped} existing shows.`,
        });
        onOpenChange(false);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Import failed",
        description: error.message || "Failed to import shows from TVMaze",
        variant: "destructive",
      });
    },
  });

  // Progress tracking with Server-Sent Events
  // Progress tracking by polling the durable sync-job status endpoint
  const startProgressTracking = (jobId: string) => {
    const applyStatus = (progressData: any) => {
      setSyncProgress({
        status: progressData.status,
        phase: progressData.phase || '',
        percent: progressData.percent || 0,
        completedEpisodes: progressData.completedShows || 0,
        totalEpisodes: progressData.totalShows || 0,
        etaSeconds: progressData.etaSeconds,
        message: progressData.message || '',
        errors: progressData.errors || [],
        episodesImported: progressData.episodesImported,
        episodesUpdated: progressData.episodesUpdated
      });

      // If job is complete
      if (progressData.status === 'success') {
        stopPolling();

        // Invalidate queries to refresh data
        queryClient.invalidateQueries({ queryKey: ["/api/library"] });
        queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });

        toast({
          title: "Import completed",
          description: `Successfully imported ${progressData.episodesImported || 0} shows, skipped ${progressData.episodesUpdated || 0} existing shows.`,
        });

        // Close dialog after brief delay
        setTimeout(() => {
          onOpenChange(false);
          setCurrentJobId(null);
          setSyncProgress(null);
        }, 3000);
      } else if (progressData.status === 'error') {
        stopPolling();
        setCurrentJobId(null);
        setSyncProgress(null);

        toast({
          title: "Import failed",
          description: progressData.message || "Failed to import shows from TVMaze",
          variant: "destructive",
        });
      }
    };

    const stopPolling = () => clearInterval(pollTimer);

    // Serializes the poll loop: a tick whose request is still in flight is
    // skipped, so overlapping requests can never deliver out-of-order
    // responses (e.g. a stale 'running' landing after a terminal state).
    let pollInFlight = false;

    // A single transient status failure must not stop tracking: the durable
    // import continues on the server, and clearing the job ID here would let
    // the user start a duplicate import. Keep polling; only give up after
    // MAX_POLL_FAILURES consecutive failures (~10s of outage), and keep the
    // job state even then so a duplicate cannot be launched.
    let consecutiveFailures = 0;
    const MAX_POLL_FAILURES = 5;

    const poll = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await fetch(`/api/library/import/${jobId}/status`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        consecutiveFailures = 0;
        applyStatus(await res.json());
      } catch (error) {
        console.error('Error polling import status:', error);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          stopPolling();
          setPollingGaveUp(true);

          toast({
            title: "Connection error",
            description: "Lost connection to import progress after several retries",
            variant: "destructive",
          });
        }
      } finally {
        pollInFlight = false;
      }
    };

    const pollTimer = setInterval(poll, 2000);
    setPollingGaveUp(false);
    void poll();
  };

  const handleStartImport = () => {
    importMutation.mutate();
  };

  // Handle dialog close with progress check
  const handleOpenChange = (openValue: boolean) => {
    // Once the poll loop has given up, let the user close even though the
    // last known status is 'running' — the job itself is durable on the
    // server and no duplicate can be started while the job ID is held.
    if (!openValue && currentJobId && syncProgress?.status === 'running' && !pollingGaveUp) {
      // Don't allow closing while import is in progress
      toast({
        title: "Import in progress",
        description: "Please wait for the library import to complete",
      });
      return;
    }
    onOpenChange(openValue);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {currentJobId ? "Importing Library" : "Import from TVMaze"}
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          {/* Progress Section */}
          {syncProgress && (
            <div className="space-y-4 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  {syncProgress.status === 'running' && (
                    <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                  )}
                  {syncProgress.status === 'success' && (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  )}
                  {syncProgress.status === 'error' && (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="font-medium">{syncProgress.phase}</span>
                </div>
                {syncProgress.etaSeconds && syncProgress.etaSeconds > 0 && (
                  <span className="text-sm text-muted-foreground">
                    ~{Math.round(syncProgress.etaSeconds)}s remaining
                  </span>
                )}
              </div>
              
              <Progress value={syncProgress.percent} className="h-2" />
              
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{syncProgress.message}</span>
                <span>
                  {syncProgress.completedEpisodes} / {syncProgress.totalEpisodes} shows
                </span>
              </div>
              
              {syncProgress.errors.length > 0 && (
                <div className="space-y-1">
                  {syncProgress.errors.slice(-3).map((error, index) => (
                    <p key={index} className="text-sm text-red-500">{error}</p>
                  ))}
                </div>
              )}

              {pollingGaveUp && syncProgress.status === 'running' && (
                <div className="flex items-center justify-between pt-2">
                  <p className="text-sm text-muted-foreground">
                    Connection to progress updates was lost; the import may still be running.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => currentJobId && startProgressTracking(currentJobId)}
                    data-testid="button-retry-progress-poll"
                  >
                    Retry
                  </Button>
                </div>
              )}

              {/* Success Summary */}
              {syncProgress.status === 'success' && (
                <div className="text-sm text-muted-foreground border-t pt-4">
                  {syncProgress.episodesImported || 0} shows imported
                  {syncProgress.episodesUpdated ? `, ${syncProgress.episodesUpdated} skipped` : ''}
                </div>
              )}
            </div>
          )}

          {/* Start Import Section */}
          {!currentJobId && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground space-y-2">
                <p>This will import all shows you're following on TVMaze into your library.</p>
                <ul className="list-disc list-inside space-y-1 ml-4">
                  <li>Fetches your followed shows from TVMaze</li>
                  <li>Imports show details and metadata</li>
                  <li>Skips shows already in your library</li>
                  <li>Typically takes 10-30 seconds depending on library size</li>
                </ul>
              </div>
              
              <Button 
                onClick={handleStartImport}
                disabled={importMutation.isPending}
                className="w-full"
                data-testid="button-start-library-import"
              >
                {importMutation.isPending ? (
                  <>
                    <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
                    Starting Import...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Start Import
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}