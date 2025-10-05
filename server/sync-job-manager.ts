export interface SyncJob {
  id: string;
  showId: number;
  status: 'queued' | 'running' | 'success' | 'error' | 'canceled';
  phase: 'fetch-show' | 'fetch-scrobbles' | 'fetch-episodes' | 'process-episodes' | 'finalize';
  totalShows: number;
  completedShows: number;
  percent: number;
  etaSeconds: number | null;
  errors: string[];
  startedAt: Date;
  updatedAt: Date;
  canceled: boolean;
  lastMessage: string;
  episodesImported: number;
  episodesUpdated: number;
}

export interface ProgressReporter {
  setPhase(phase: SyncJob['phase'], message: string): void;
  setTotal(total: number): void;
  incrementCompleted(message?: string): void;
  addError(error: string): void;
  checkCanceled(): boolean;
  getJob(): SyncJob;
}

export class SyncJobManager {
  private jobs = new Map<string, SyncJob>();
  private subscribers = new Map<string, Set<(event: string) => void>>();

  createJob(showId: number): string {
    const id = `sync_${showId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const job: SyncJob = {
      id,
      showId,
      status: 'queued',
      phase: 'fetch-show',
      totalShows: 0,
      completedShows: 0,
      percent: 0,
      etaSeconds: null,
      errors: [],
      startedAt: new Date(),
      updatedAt: new Date(),
      canceled: false,
      lastMessage: 'Starting sync...',
      episodesImported: 0,
      episodesUpdated: 0
    };

    this.jobs.set(id, job);
    return id;
  }

  getJob(id: string): SyncJob | null {
    return this.jobs.get(id) || null;
  }

  getActiveJobs(): SyncJob[] {
    const activeJobs: SyncJob[] = [];
    Array.from(this.jobs.values()).forEach(job => {
      if (job.status === 'running') {
        activeJobs.push(job);
      }
    });
    return activeJobs;
  }

  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (job && job.status === 'running') {
      job.canceled = true;
      job.status = 'canceled';
      job.lastMessage = 'Sync canceled by user';
      job.updatedAt = new Date();
      this.emitEvent(id, 'canceled', { message: job.lastMessage });
      return true;
    }
    return false;
  }

  createReporter(jobId: string): ProgressReporter {
    const startTime = Date.now();
    let processStartTime: number | null = null;

    return {
      setPhase: (phase, message) => {
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.phase = phase;
        job.lastMessage = message;
        job.updatedAt = new Date();
        
        if (phase === 'process-episodes') {
          processStartTime = Date.now();
        }

        this.emitEvent(jobId, 'progress', {
          phase,
          message,
          percent: job.percent,
          completedShows: job.completedShows,
          totalShows: job.totalShows,
          etaSeconds: job.etaSeconds
        });
      },

      setTotal: (total) => {
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.totalShows = total;
        job.updatedAt = new Date();
        
        this.emitEvent(jobId, 'progress', {
          phase: job.phase,
          message: job.lastMessage,
          percent: job.percent,
          completedShows: job.completedShows,
          totalShows: total,
          etaSeconds: job.etaSeconds
        });
      },

      incrementCompleted: (message) => {
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.completedShows++;
        job.updatedAt = new Date();
        
        if (message) {
          job.lastMessage = message;
        }

        // Calculate percentage
        if (job.totalShows > 0) {
          job.percent = Math.round((job.completedShows / job.totalShows) * 100);
        }

        // Calculate ETA after processing at least 3 shows
        if (processStartTime && job.completedShows >= 3) {
          const elapsed = (Date.now() - processStartTime) / 1000; // seconds
          const avgPerShow = elapsed / job.completedShows;
          const remaining = job.totalShows - job.completedShows;
          job.etaSeconds = Math.round(remaining * avgPerShow);
        }

        // Throttle progress events (emit every show or if it's been more than 1 second)
        const shouldEmit = job.completedShows % 1 === 0 || 
                          (Date.now() - job.updatedAt.getTime()) > 1000;

        if (shouldEmit) {
          this.emitEvent(jobId, 'progress', {
            phase: job.phase,
            message: job.lastMessage,
            percent: job.percent,
            completedShows: job.completedShows,
            totalShows: job.totalShows,
            etaSeconds: job.etaSeconds
          });
        }
      },

      addError: (error) => {
        const job = this.jobs.get(jobId);
        if (!job) return;

        job.errors.push(error);
        job.updatedAt = new Date();
        
        this.emitEvent(jobId, 'error', {
          error,
          errorCount: job.errors.length
        });
      },

      checkCanceled: () => {
        const job = this.jobs.get(jobId);
        return job?.canceled || false;
      },

      getJob: () => {
        return this.jobs.get(jobId)!;
      }
    };
  }

  markJobSuccess(jobId: string, episodesImported: number, episodesUpdated: number): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'success';
    job.episodesImported = episodesImported;
    job.episodesUpdated = episodesUpdated;
    job.lastMessage = `Sync completed successfully. ${episodesImported} episodes imported, ${episodesUpdated} updated.`;
    job.percent = 100;
    job.updatedAt = new Date();

    this.emitEvent(jobId, 'complete', {
      episodesImported,
      episodesUpdated,
      message: job.lastMessage
    });
  }

  markJobError(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'error';
    job.lastMessage = `Sync failed: ${error}`;
    job.updatedAt = new Date();

    this.emitEvent(jobId, 'error', {
      error,
      fatal: true,
      message: job.lastMessage
    });
  }

  markJobRunning(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'running';
    job.updatedAt = new Date();
  }

  subscribe(jobId: string, callback: (event: string) => void): () => void {
    if (!this.subscribers.has(jobId)) {
      this.subscribers.set(jobId, new Set());
    }
    
    this.subscribers.get(jobId)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      const subs = this.subscribers.get(jobId);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.subscribers.delete(jobId);
        }
      }
    };
  }

  private emitEvent(jobId: string, type: string, data: any): void {
    const subscribers = this.subscribers.get(jobId);
    if (!subscribers) return;

    const event = `data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`;
    
    subscribers.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error emitting SSE event:', error);
      }
    });
  }

  // Cleanup old jobs (called periodically)
  cleanup(): void {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
    
    Array.from(this.jobs.entries()).forEach(([id, job]) => {
      if (job.updatedAt.getTime() < cutoff && 
          ['success', 'error', 'canceled'].includes(job.status)) {
        this.jobs.delete(id);
        this.subscribers.delete(id);
      }
    });
  }
}

// Global instance
export const syncJobManager = new SyncJobManager();

// Cleanup old jobs every hour
setInterval(() => {
  syncJobManager.cleanup();
}, 60 * 60 * 1000);