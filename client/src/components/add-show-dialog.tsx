import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tvmaze, TVMazeSearchResult } from "@/lib/tvmaze";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Plus, X, CheckCircle, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface SyncProgress {
  status: 'running' | 'success' | 'error';
  phase: string;
  percent: number;
  completedEpisodes: number;
  totalEpisodes: number;
  etaSeconds?: number;
  message: string;
  errors: string[];
}

interface AddShowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddShowDialog({ open, onOpenChange }: AddShowDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  // Set when the poll loop gives up after repeated transient failures. The
  // dialog stays open on the last known progress and the job ID is kept, so
  // the user cannot start a duplicate import from this dialog.
  const [pollingGaveUp, setPollingGaveUp] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: searchResults, isLoading: isSearching } = useQuery({
    queryKey: ["/api/shows/search", searchQuery],
    queryFn: () => tvmaze.searchShows(searchQuery),
    enabled: searchQuery.length > 2,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const addShowMutation = useMutation({
    mutationFn: async (showId: number) => {
      const res = await apiRequest("POST", "/api/user/shows", {
        showId,
        status: "new",
      });
      // apiRequest returns the raw Response; parse it so onSuccess sees
      // the JSON body (including jobId) and the progress poller can start.
      return res.json();
    },
    onSuccess: (data: any) => {
      // If we get a job ID, start progress tracking
      if (data.jobId) {
        setCurrentJobId(data.jobId);
        startProgressTracking(data.jobId);
        
        toast({
          title: "Show added",
          description: data.message || "Episodes are being imported in the background...",
        });
      } else {
        // Fallback for synchronous response
        queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/search"], exact: false });
        
        toast({
          title: "Show added",
          description: data.message || "The show has been added to your collection.",
        });
        onOpenChange(false);
        setSearchQuery("");
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add show",
        variant: "destructive",
      });
    },
  });

  // Progress tracking with Server-Sent Events
  // Progress tracking by polling the durable sync-job status endpoint
  const startProgressTracking = (jobId: string) => {
    const applyStatus = (progressData: any) => {
      setSyncProgress({
        // A queued row is live work (created, worker not yet started):
        // treat it as active so the dialog stays open and no duplicate
        // import can start.
        status: progressData.status === "queued" ? "running" : progressData.status,
        phase: progressData.phase || '',
        percent: progressData.percent || 0,
        completedEpisodes: progressData.completedShows || 0,
        totalEpisodes: progressData.totalShows || 0,
        etaSeconds: progressData.etaSeconds,
        message: progressData.lastMessage || progressData.message || '',
        errors: progressData.errors || []
      });

      // If job is complete
      if (progressData.status === 'success') {
        stopPolling();

        // Invalidate queries to refresh data
        queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
        queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/search"], exact: false });

        toast({
          title: "Import completed",
          description: `Successfully imported ${progressData.episodesImported || progressData.completedShows || 0} episodes${progressData.episodesUpdated && progressData.episodesUpdated > 0 ? ` with ${progressData.episodesUpdated} synced from your watch history` : ''}`,
        });

        // Close dialog after a brief delay
        setTimeout(() => {
          onOpenChange(false);
          setSearchQuery("");
          setCurrentJobId(null);
          setSyncProgress(null);
        }, 2000);
      } else if (progressData.status === 'error') {
        stopPolling();
        setCurrentJobId(null);
        setSyncProgress(null);

        toast({
          title: "Import failed",
          description: progressData.lastMessage || progressData.message || "Failed to import episodes",
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
    // job continues on the server, and clearing the job ID here would let
    // the user start a duplicate import. Keep polling; only give up after
    // MAX_POLL_FAILURES consecutive failures (~10s of outage), and keep the
    // job state even then so a duplicate cannot be launched.
    let consecutiveFailures = 0;
    const MAX_POLL_FAILURES = 5;

    const poll = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await fetch(`/api/sync/${jobId}/status`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        consecutiveFailures = 0;
        applyStatus(await res.json());
      } catch (error) {
        console.error('Error polling sync status:', error);
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

  const handleAddShow = (showId: number) => {
    addShowMutation.mutate(showId);
  };

  const getImageUrl = (result: TVMazeSearchResult) => {
    if (result.show.image?.medium) {
      return result.show.image.medium;
    }
    return `https://via.placeholder.com/80x120/374151/9ca3af?text=${encodeURIComponent(result.show.name)}`;
  };

  // Handle dialog close with progress check
  const handleOpenChange = (open: boolean) => {
    // Once the poll loop has given up, let the user close even though the
    // last known status is 'running' — the job itself is durable on the
    // server and no duplicate can be started while the job ID is held.
    if (!open && currentJobId && syncProgress?.status === 'running' && !pollingGaveUp) {
      // Don't allow closing while sync is in progress
      toast({
        title: "Import in progress",
        description: "Please wait for the episode import to complete",
      });
      return;
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {currentJobId ? "Importing Episodes" : "Add TV Show"}
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
                  {syncProgress.completedEpisodes} / {syncProgress.totalEpisodes} episodes
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
            </div>
          )}

          {/* Search Input */}
          {!currentJobId && (
            <>
              <div className="relative">
                <Input
                  placeholder="Search for TV shows..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="input-search-shows-dialog"
                  className="pl-10"
                />
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              </div>

              {/* Search Results */}
              <div className="flex-1 overflow-y-auto space-y-2">
                {searchQuery.length <= 2 && (
                  <p className="text-muted-foreground text-center py-8">
                    Type at least 3 characters to search for shows
                  </p>
                )}
                
                {isSearching && (
                  <p className="text-muted-foreground text-center py-8">
                    Searching for shows...
                  </p>
                )}
                
                {searchResults && searchResults.length === 0 && searchQuery.length > 2 && (
                  <p className="text-muted-foreground text-center py-8">
                    No shows found for "{searchQuery}"
                  </p>
                )}
                
                {searchResults?.map((result) => (
                  <div 
                    key={result.show.id} 
                    className="flex items-start space-x-3 p-3 bg-card rounded-lg hover:bg-card/80 transition-colors"
                    data-testid={`search-result-${result.show.id}`}
                  >
                    <img
                      src={getImageUrl(result)}
                      alt={`${result.show.name} poster`}
                      className="w-12 h-16 object-cover rounded flex-shrink-0"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.src = `https://via.placeholder.com/80x120/374151/9ca3af?text=${encodeURIComponent(result.show.name)}`;
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold truncate" data-testid={`text-search-result-title-${result.show.id}`}>
                        {result.show.name}
                      </h3>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {result.show.genres?.slice(0, 3).map((genre) => (
                          <Badge key={genre} variant="secondary" className="text-xs">
                            {genre}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {result.show.network?.name || "Unknown Network"} • {result.show.premiered ? new Date(result.show.premiered).getFullYear() : "Unknown Year"}
                      </p>
                      {result.show.summary && (
                        <p 
                          className="text-xs text-muted-foreground mt-2 line-clamp-2"
                          dangerouslySetInnerHTML={{ 
                            __html: result.show.summary.replace(/<[^>]*>/g, '').substring(0, 100) + "..." 
                          }}
                        />
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleAddShow(result.show.id)}
                      disabled={addShowMutation.isPending || currentJobId !== null}
                      data-testid={`button-add-show-${result.show.id}`}
                      className="flex-shrink-0"
                    >
                      {addShowMutation.isPending ? (
                        <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                      ) : (
                        <Plus className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
