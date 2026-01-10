import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserEpisode, Episode, Show, NewReleaseShow, Recommendation } from "@shared/schema";
import EpisodeCard from "@/components/episode-card";
import { PlayCircle, AlertTriangle, ChevronDown, Play, Clock, Eye, SkipForward, Share, User, Calendar, Loader2, X, Plus, RefreshCw, CheckCheck, Sparkles, Timer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link, useParams, useLocation } from "wouter";
import CountdownTimer from "@/components/countdown-timer";

interface NewReleasesResponse {
  shows: NewReleaseShow[];
  lastChecked: string | null;
  fromCache: boolean;
}

const VALID_TABS = ["queue", "countdown", "triage", "discover"] as const;
type TabType = typeof VALID_TABS[number];

export default function Dashboard() {
  const params = useParams<{ tab?: string }>();
  const [, setLocation] = useLocation();
  const [hiddenEpisodes, setHiddenEpisodes] = useState<Set<number>>(new Set());
  const [expandedSeasons, setExpandedSeasons] = useState<Record<string, Set<number>>>({});
  const [newReleaseProcessingId, setNewReleaseProcessingId] = useState<number | null>(null);
  const [dismissedNewReleases, setDismissedNewReleases] = useState<Set<number>>(new Set());
  const [recProcessingTmdbId, setRecProcessingTmdbId] = useState<number | null>(null);
  const [dismissedRecs, setDismissedRecs] = useState<Set<number>>(new Set());
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const activeTab: TabType = VALID_TABS.includes(params.tab as TabType) ? (params.tab as TabType) : "queue";

  const handleTabChange = (value: string) => {
    if (value === "queue") {
      setLocation("/dashboard");
    } else {
      setLocation(`/dashboard/${value}`);
    }
  };

  // User settings query to get show mode
  const { data: userSettings } = useQuery({
    queryKey: ["/api/user/settings"],
    queryFn: async () => {
      const response = await fetch('/api/user/settings');
      if (!response.ok) throw new Error('Failed to fetch user settings');
      return response.json();
    },
  });

  const showMode = userSettings?.showMode || 'personal';

  // Episode queries
  const { data: nextEpisodes, isLoading: nextLoading } = useQuery({
    queryKey: ["/api/user/episodes", "next", showMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', 'next');
      if (showMode) {
        params.set('showMode', showMode);
      }
      const response = await fetch(`/api/user/episodes?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch next episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
    enabled: !!userSettings,
  });

  // Watch Later episodes query
  const { data: laterEpisodes, isLoading: laterLoading } = useQuery({
    queryKey: ["/api/user/episodes", "later", showMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', 'later');
      if (showMode) {
        params.set('showMode', showMode);
      }
      const response = await fetch(`/api/user/episodes?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch later episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
    enabled: !!userSettings,
  });

  // Untriaged episodes query
  const { data: untriagedEpisodes, isLoading: untriagedLoading } = useQuery({
    queryKey: ["/api/user/episodes", "untriaged", showMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', 'untriaged');
      if (showMode) {
        params.set('showMode', showMode);
      }
      const response = await fetch(`/api/user/episodes?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch untriaged episodes");
      return response.json() as Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
    },
    enabled: !!userSettings,
  });

  // User shows query to get sharing status
  const { data: userShows } = useQuery({
    queryKey: ["/api/user/shows"],
    queryFn: async () => {
      const response = await fetch("/api/user/shows");
      if (!response.ok) throw new Error("Failed to fetch user shows");
      return response.json() as Promise<{id: string; showId: number; isShared: boolean; addedAt: string}[]>;
    },
  });

  // New releases query
  const { data: newReleasesData, isLoading: newReleasesLoading } = useQuery<NewReleasesResponse>({
    queryKey: ["/api/new-releases"],
    staleTime: 1000 * 60 * 5,
  });

  const newReleases = newReleasesData?.shows || [];
  const visibleNewReleases = newReleases.filter(show => !dismissedNewReleases.has(show.id));

  // Recommendations query
  const { data: recommendations = [], isLoading: recommendationsLoading } = useQuery<Recommendation[]>({
    queryKey: ["/api/recommendations"],
    staleTime: 1000 * 60 * 5,
  });

  const visibleRecommendations = recommendations.filter(rec => !dismissedRecs.has(rec.tmdbId));

  // Helper function to get the earliest episode per show for Next Up
  const getNextEpisodesByShow = useMemo(() => {
    if (!nextEpisodes) return [];
    
    const grouped = new Map<number, (UserEpisode & { episode: Episode & { show: Show } })[]>();
    
    nextEpisodes.forEach(userEpisode => {
      const showId = userEpisode.episode.show.id;
      if (!grouped.has(showId)) {
        grouped.set(showId, []);
      }
      grouped.get(showId)!.push(userEpisode);
    });
    
    return Array.from(grouped.entries()).map(([showId, episodes]) => {
      const earliestEpisode = episodes.sort((a, b) => {
        const seasonA = a.episode.season || 1;
        const seasonB = b.episode.season || 1;
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = a.episode.number || 0;
        const episodeB = b.episode.number || 0;
        return episodeA - episodeB;
      })[0];
      
      return earliestEpisode;
    }).sort((a, b) => a.episode.show.name.localeCompare(b.episode.show.name));
  }, [nextEpisodes]);

  // Helper function to get the earliest episode per show for Watch Later
  const getLaterEpisodesByShow = useMemo(() => {
    if (!laterEpisodes) return [];
    
    const grouped = new Map<number, (UserEpisode & { episode: Episode & { show: Show } })[]>();
    
    laterEpisodes.forEach(userEpisode => {
      const showId = userEpisode.episode.show.id;
      if (!grouped.has(showId)) {
        grouped.set(showId, []);
      }
      grouped.get(showId)!.push(userEpisode);
    });
    
    return Array.from(grouped.entries()).map(([showId, episodes]) => {
      const earliestEpisode = episodes.sort((a, b) => {
        const seasonA = a.episode.season || 1;
        const seasonB = b.episode.season || 1;
        if (seasonA !== seasonB) return seasonA - seasonB;
        
        const episodeA = a.episode.number || 0;
        const episodeB = b.episode.number || 0;
        return episodeA - episodeB;
      })[0];
      
      return earliestEpisode;
    }).sort((a, b) => a.episode.show.name.localeCompare(b.episode.show.name));
  }, [laterEpisodes]);

  // Group untriaged episodes by show and season
  const groupEpisodesByShowAndSeason = useMemo(() => {
    if (!untriagedEpisodes) return {};
    
    const filteredEpisodes = untriagedEpisodes.filter(userEpisode => 
      !hiddenEpisodes.has(userEpisode.episode.id) && 
      userEpisode.episode.airdate
    );
    
    const grouped: Record<string, {
      show: Show;
      seasons: Record<number, (UserEpisode & { episode: Episode & { show: Show } })[]>;
      mostRecentSeason: number;
      allSeasons: number[];
    }> = {};

    filteredEpisodes.forEach(userEpisode => {
      const { show } = userEpisode.episode;
      const season = userEpisode.episode.season || 1;
      
      if (!grouped[show.id]) {
        grouped[show.id] = {
          show,
          seasons: {},
          mostRecentSeason: season,
          allSeasons: []
        };
      }
      
      if (!grouped[show.id].seasons[season]) {
        grouped[show.id].seasons[season] = [];
      }
      
      grouped[show.id].seasons[season].push(userEpisode);
      
      if (season > grouped[show.id].mostRecentSeason) {
        grouped[show.id].mostRecentSeason = season;
      }
    });

    Object.values(grouped).forEach(showData => {
      showData.allSeasons = Object.keys(showData.seasons)
        .map(Number)
        .sort((a, b) => b - a);
      
      Object.values(showData.seasons).forEach(seasonEpisodes => {
        seasonEpisodes.sort((a, b) => {
          const episodeA = a.episode.number || 0;
          const episodeB = b.episode.number || 0;
          return episodeA - episodeB;
        });
      });
    });

    return grouped;
  }, [untriagedEpisodes, hiddenEpisodes]);

  const getVisibleSeasonsForShow = (showId: string, showData: any) => {
    const expandedForShow = expandedSeasons[showId] || new Set();
    const { mostRecentSeason, allSeasons } = showData;
    
    const visibleSeasons = new Set([mostRecentSeason]);
    Array.from(expandedForShow).forEach((season: number) => visibleSeasons.add(season));
    
    return allSeasons.filter((season: number) => visibleSeasons.has(season));
  };

  const loadEarlierSeason = (showId: string, currentVisibleSeasons: number[], allSeasons: number[]) => {
    const oldestVisible = Math.min(...currentVisibleSeasons);
    const nextOlderSeason = allSeasons.find(season => season < oldestVisible);
    
    if (nextOlderSeason) {
      setExpandedSeasons(prev => ({
        ...prev,
        [showId]: new Set([...Array.from(prev[showId] || []), nextOlderSeason])
      }));
    }
  };

  const checkAutoProgression = (episodeId: number, showId: string) => {
    const showData = groupEpisodesByShowAndSeason[showId];
    if (!showData) return;

    const visibleSeasons = getVisibleSeasonsForShow(showId, showData);
    
    const allVisibleEpisodesHidden = visibleSeasons.every((season: number) => {
      const seasonEpisodes = showData.seasons[season] || [];
      return seasonEpisodes.every(ep => 
        hiddenEpisodes.has(ep.episode.id) || !ep.episode.airdate
      );
    });

    if (allVisibleEpisodesHidden && showData.allSeasons.length > visibleSeasons.length) {
      const oldestVisible = Math.min(...visibleSeasons);
      const nextOlderSeason = showData.allSeasons.find(season => season < oldestVisible);
      
      if (nextOlderSeason) {
        setTimeout(() => {
          setExpandedSeasons(prev => ({
            ...prev,
            [showId]: new Set([...Array.from(prev[showId] || []), nextOlderSeason])
          }));
        }, 300);
      }
    }
  };

  // Episode update mutation for Next Up section
  const updateNextEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      const previousData = queryClient.getQueryData(["/api/user/episodes", "next", showMode]);

      let updatedEpisodeInfo = null;

      if (previousData && Array.isArray(previousData)) {
        const episodeIndex = (previousData as any[]).findIndex((ep: any) => ep.episode.id === episodeId);
        if (episodeIndex !== -1) {
          const episode = (previousData as any[])[episodeIndex];
          
          updatedEpisodeInfo = {
            showName: episode.episode.show.name,
            season: episode.episode.season,
            number: episode.episode.number
          };
          
          if (status !== "next") {
            const updatedData = (previousData as any[]).filter((_: any, index: number) => index !== episodeIndex);
            queryClient.setQueryData(["/api/user/episodes", "next", showMode], updatedData);
          }
        }
      }

      return { previousData, episodeInfo: updatedEpisodeInfo, episodeId };
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/user/episodes", "next", showMode], context.previousData);
      }
      
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data, variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes/upcoming"] });
      
      let toastTitle = "Episode updated";
      if (context?.episodeInfo) {
        const { showName, season, number } = context.episodeInfo;
        toastTitle = `${showName} ${season}x${number}`;
      }
      
      toast({
        title: toastTitle,
        description: "Episode status has been updated.",
      });
    },
  });

  // Episode update mutation for Triage section (with hidden state management)
  const updateTriageEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      const previousData = {
        next: queryClient.getQueryData(["/api/user/episodes", "next", "personal"]),
        later: queryClient.getQueryData(["/api/user/episodes", "later", "personal"]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched", "personal"]),
      };

      let updatedEpisodeInfo = null;

      Object.entries(previousData).forEach(([currentStatus, data]: [string, any]) => {
        if (data && Array.isArray(data)) {
          const episodeIndex = data.findIndex((ep: any) => ep.episode.id === episodeId);
          if (episodeIndex !== -1) {
            const episode = data[episodeIndex];
            
            updatedEpisodeInfo = {
              showName: episode.episode.show.name,
              season: episode.episode.season,
              number: episode.episode.number
            };
            
            const updatedCurrentData = data.filter((_: any, index: number) => index !== episodeIndex);
            queryClient.setQueryData(["/api/user/episodes", currentStatus, "personal"], updatedCurrentData);
            
            const updatedEpisode = {
              ...episode,
              status,
              triagedAt: new Date().toISOString(),
              ...(status === "watched" && { watchedAt: new Date().toISOString() })
            };
            
            const newStatusData = queryClient.getQueryData(["/api/user/episodes", status, "personal"]) as any[] || [];
            queryClient.setQueryData(["/api/user/episodes", status, "personal"], [...newStatusData, updatedEpisode]);
          }
        }
      });

      if (!updatedEpisodeInfo) {
        const untriagedData = queryClient.getQueryData(["/api/user/episodes", "untriaged"]) as any[];
        if (untriagedData) {
          const episode = untriagedData.find((ep: any) => ep.episode.id === episodeId);
          if (episode) {
            updatedEpisodeInfo = {
              showName: episode.episode.show.name,
              season: episode.episode.season,
              number: episode.episode.number
            };
          }
        }
      }

      return { episodeId, episodeInfo: updatedEpisodeInfo, previousData };
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        Object.entries(context.previousData).forEach(([status, data]) => {
          queryClient.setQueryData(["/api/user/episodes", status, "personal"], data);
        });
      }
      
      if (context?.episodeId) {
        setHiddenEpisodes(prev => {
          const newSet = new Set(prev);
          newSet.delete(context.episodeId);
          return newSet;
        });
      }
      
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data, variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"], exact: false });
      
      let toastTitle = "Episode updated";
      if (context?.episodeInfo) {
        const { showName, season, number } = context.episodeInfo;
        toastTitle = `${showName} ${season}x${number}`;
      }
      
      toast({
        title: toastTitle,
        description: "Episode status has been updated.",
      });
    },
  });

  // Update show sharing status mutation
  const updateShowSharingMutation = useMutation({
    mutationFn: async ({ showId, isShared }: { showId: number; isShared: boolean }) => {
      return apiRequest("PATCH", `/api/user/shows/${showId}/shared`, { isShared });
    },
    onMutate: async ({ showId, isShared }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/user/shows"] });
      
      const previousUserShows = queryClient.getQueryData(["/api/user/shows"]);
      
      queryClient.setQueryData(["/api/user/shows"], (oldData: any) => {
        if (!oldData) return oldData;
        return oldData.map((userShow: any) => 
          userShow.showId === showId 
            ? { ...userShow, isShared }
            : userShow
        );
      });
      
      return { previousUserShows };
    },
    onSuccess: (data, variables) => {
      toast({
        title: "Show updated",
        description: `Show marked as ${variables.isShared ? 'shared' : 'personal'}`,
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousUserShows) {
        queryClient.setQueryData(["/api/user/shows"], context.previousUserShows);
      }
      
      toast({
        title: "Error",
        description: "Failed to update show sharing status",
        variant: "destructive",
      });
    },
  });

  // Bulk season status change mutation
  const bulkSeasonStatusMutation = useMutation({
    mutationFn: async ({ episodesList, status }: { episodesList: any[], status: string }) => {
      const promises = episodesList.map(userEpisode => 
        apiRequest("PATCH", `/api/user/episodes/${userEpisode.episode.id}`, { status })
      );
      return Promise.all(promises);
    },
    onMutate: async ({ episodesList, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      const previousData = {
        next: queryClient.getQueryData(["/api/user/episodes", "next", "personal"]),
        later: queryClient.getQueryData(["/api/user/episodes", "later", "personal"]),
        watched: queryClient.getQueryData(["/api/user/episodes", "watched", "personal"]),
      };

      if (status !== "untriaged") {
        episodesList.forEach(userEpisode => {
          setHiddenEpisodes(prev => new Set(prev).add(userEpisode.episode.id));
        });
      }

      episodesList.forEach(userEpisode => {
        const episodeId = userEpisode.episode.id;
        
        Object.entries(previousData).forEach(([currentStatus, data]: [string, any]) => {
          if (data && Array.isArray(data)) {
            const episodeIndex = data.findIndex((ep: any) => ep.episode.id === episodeId);
            if (episodeIndex !== -1) {
              const updatedCurrentData = data.filter((_: any, index: number) => index !== episodeIndex);
              queryClient.setQueryData(["/api/user/episodes", currentStatus, "personal"], updatedCurrentData);
              
              const episode = data[episodeIndex];
              const updatedEpisode = {
                ...episode,
                status,
                triagedAt: new Date().toISOString(),
                ...(status === "watched" && { watchedAt: new Date().toISOString() })
              };
              
              const newStatusData = queryClient.getQueryData(["/api/user/episodes", status, "personal"]) as any[] || [];
              queryClient.setQueryData(["/api/user/episodes", status, "personal"], [...newStatusData, updatedEpisode]);
            }
          }
        });
      });

      return { 
        previousData,
        episodeIds: episodesList.map(ep => ep.episode.id),
        showName: episodesList[0]?.episode?.show?.name,
        season: episodesList[0]?.episode?.season
      };
    },
    onSuccess: (data, variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"], exact: false });
      
      if (context?.showName && context?.season) {
        toast({
          title: `${context.showName} Season ${context.season}`,
          description: `${variables.episodesList.length} episodes marked as ${variables.status}`,
        });
      }
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        Object.entries(context.previousData).forEach(([status, data]) => {
          queryClient.setQueryData(["/api/user/episodes", status, "personal"], data);
        });
      }
      
      if (context?.episodeIds) {
        setHiddenEpisodes(prev => {
          const newSet = new Set(prev);
          context.episodeIds.forEach((id: number) => newSet.delete(id));
          return newSet;
        });
      }
      
      toast({
        title: "Error",
        description: "Failed to update episodes. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleNextEpisodeStatusChange = (episodeId: number, status: string) => {
    updateNextEpisodeMutation.mutate({ episodeId, status });
  };

  // Episode update mutation for Watch Later section
  const updateLaterEpisodeMutation = useMutation({
    mutationFn: async ({ episodeId, status }: { episodeId: number; status: string }) => {
      return apiRequest("PATCH", `/api/user/episodes/${episodeId}`, { status });
    },
    onMutate: async ({ episodeId, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/user/episodes"] });

      const previousData = queryClient.getQueryData(["/api/user/episodes", "later", showMode]);

      let updatedEpisodeInfo = null;

      if (previousData && Array.isArray(previousData)) {
        const episodeIndex = (previousData as any[]).findIndex((ep: any) => ep.episode.id === episodeId);
        if (episodeIndex !== -1) {
          const episode = (previousData as any[])[episodeIndex];
          
          updatedEpisodeInfo = {
            showName: episode.episode.show.name,
            season: episode.episode.season,
            number: episode.episode.number
          };
          
          if (status !== "later") {
            const updatedData = (previousData as any[]).filter((_: any, index: number) => index !== episodeIndex);
            queryClient.setQueryData(["/api/user/episodes", "later", showMode], updatedData);
          }
        }
      }

      return { previousData, episodeInfo: updatedEpisodeInfo, episodeId };
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/user/episodes", "later", showMode], context.previousData);
      }
      
      toast({
        title: "Error",
        description: "Failed to update episode. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data, variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      
      let toastTitle = "Episode updated";
      if (context?.episodeInfo) {
        const { showName, season, number } = context.episodeInfo;
        toastTitle = `${showName} ${season}x${number}`;
      }
      
      toast({
        title: toastTitle,
        description: "Episode status has been updated.",
      });
    },
  });

  const handleLaterEpisodeStatusChange = (episodeId: number, status: string) => {
    updateLaterEpisodeMutation.mutate({ episodeId, status });
  };

  const handleTriageEpisodeStatusChange = (episodeId: number, status: string) => {
    let showId = '';
    if (untriagedEpisodes) {
      const episode = untriagedEpisodes.find(ep => ep.episode.id === episodeId);
      showId = episode?.episode?.show?.id?.toString() || '';
    }

    if (status !== "untriaged") {
      setHiddenEpisodes(prev => new Set(prev).add(episodeId));

      if (showId) {
        checkAutoProgression(episodeId, showId);
      }
    }

    updateTriageEpisodeMutation.mutate({ episodeId, status });
  };

  const handleBulkSeasonStatusChange = (episodesList: any[], status: string) => {
    bulkSeasonStatusMutation.mutate({ episodesList, status });
  };

  const getShowSharingStatus = (showId: number): { isShared?: boolean; userShowId?: string } => {
    if (!userShows) return {};
    const userShow = userShows.find(us => us.showId === showId);
    return {
      isShared: userShow?.isShared,
      userShowId: userShow?.id
    };
  };

  // New releases mutations
  const newReleaseRefreshMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/new-releases/refresh");
      return response.json();
    },
    onSuccess: (result: NewReleasesResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      toast({
        title: "New releases refreshed",
        description: `Showing ${result.shows.length} new releases`,
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to refresh new releases",
      });
    },
  });

  const newReleaseDismissMutation = useMutation({
    mutationFn: async (tvmazeId: number) => {
      setDismissedNewReleases(prev => new Set(prev).add(tvmazeId));
      const response = await apiRequest("POST", "/api/new-releases/dismiss", { tvmazeId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      toast({
        title: "Dismissed",
        description: "Show removed from new releases",
      });
    },
    onError: (error: Error, tvmazeId: number) => {
      setDismissedNewReleases(prev => {
        const newSet = new Set(prev);
        newSet.delete(tvmazeId);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to dismiss show",
      });
    },
  });

  const newReleaseAddMutation = useMutation({
    mutationFn: async (show: NewReleaseShow) => {
      setDismissedNewReleases(prev => new Set(prev).add(show.id));
      setNewReleaseProcessingId(show.id);
      const response = await apiRequest("POST", "/api/new-releases/add", { tvmazeId: show.id });
      return response.json();
    },
    onSuccess: () => {
      setNewReleaseProcessingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/new-releases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Added to library",
        description: "Show added successfully. Episodes are being synced in the background.",
      });
    },
    onError: (error: Error, show: NewReleaseShow) => {
      setNewReleaseProcessingId(null);
      setDismissedNewReleases(prev => {
        const newSet = new Set(prev);
        newSet.delete(show.id);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add show",
      });
    },
  });

  // Recommendations mutations
  const recRefreshMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/recommendations/refresh");
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      const displayCount = Math.min(data.imported, 25);
      toast({
        title: "Recommendations refreshed",
        description: `Showing top ${displayCount} recommendations`,
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to refresh recommendations",
      });
    },
  });

  const recDismissMutation = useMutation({
    mutationFn: async (tmdbId: number) => {
      setDismissedRecs(prev => new Set(prev).add(tmdbId));
      const response = await apiRequest("POST", "/api/recommendations/dismiss", { tmdbId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      toast({
        title: "Dismissed",
        description: "Show removed from recommendations",
      });
    },
    onError: (error: Error, tmdbId: number) => {
      setDismissedRecs(prev => {
        const newSet = new Set(prev);
        newSet.delete(tmdbId);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to dismiss recommendation",
      });
    },
  });

  const recAcceptMutation = useMutation({
    mutationFn: async ({ tmdbId, showName }: { tmdbId: number; showName: string }) => {
      setDismissedRecs(prev => new Set(prev).add(tmdbId));
      setRecProcessingTmdbId(tmdbId);
      
      const tvmazeResponse = await fetch(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(showName)}`
      );
      const tvmazeResults = await tvmazeResponse.json();

      if (tvmazeResults.length === 0) {
        throw new Error("Show not found on TVMaze");
      }

      const tvmazeId = tvmazeResults[0].show.id;

      const response = await apiRequest("POST", "/api/recommendations/accept", { tmdbId, tvmazeId });
      return response.json();
    },
    onSuccess: () => {
      setRecProcessingTmdbId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Added to library",
        description: "Show added successfully. Episodes are being synced in the background.",
      });
    },
    onError: (error: Error, { tmdbId }: { tmdbId: number; showName: string }) => {
      setRecProcessingTmdbId(null);
      setDismissedRecs(prev => {
        const newSet = new Set(prev);
        newSet.delete(tmdbId);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add show",
      });
    },
  });

  const recAcceptWatchedMutation = useMutation({
    mutationFn: async ({ tmdbId, showName }: { tmdbId: number; showName: string }) => {
      setDismissedRecs(prev => new Set(prev).add(tmdbId));
      setRecProcessingTmdbId(tmdbId);
      
      const tvmazeResponse = await fetch(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(showName)}`
      );
      const tvmazeResults = await tvmazeResponse.json();

      if (tvmazeResults.length === 0) {
        throw new Error("Show not found on TVMaze");
      }

      const tvmazeId = tvmazeResults[0].show.id;

      const response = await apiRequest("POST", "/api/recommendations/accept-watched", { tmdbId, tvmazeId });
      return response.json();
    },
    onSuccess: () => {
      setRecProcessingTmdbId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Added as watched",
        description: "Show added successfully. All episodes are being marked as watched.",
      });
    },
    onError: (error: Error, { tmdbId }: { tmdbId: number; showName: string }) => {
      setRecProcessingTmdbId(null);
      setDismissedRecs(prev => {
        const newSet = new Set(prev);
        newSet.delete(tmdbId);
        return newSet;
      });
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add show",
      });
    },
  });

  function stripHtml(html: string | null): string {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, "");
  }

  function formatPremiereDate(dateStr: string | null): string {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays > 0) {
      if (diffDays === 1) return "Tomorrow";
      if (diffDays <= 7) return `In ${diffDays} days`;
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } else if (diffDays === 0) {
      return "Today";
    } else {
      const absDays = Math.abs(diffDays);
      if (absDays === 1) return "Yesterday";
      if (absDays <= 7) return `${absDays} days ago`;
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="mb-6 mx-auto flex w-fit">
          <TabsTrigger value="queue" className="gap-1 sm:gap-2 px-2 sm:px-3" data-testid="tab-queue">
            <PlayCircle className="h-4 w-4" />
            <span className="hidden sm:inline">Queue</span>
          </TabsTrigger>
          <TabsTrigger value="countdown" className="gap-1 sm:gap-2 px-2 sm:px-3" data-testid="tab-countdown">
            <Timer className="h-4 w-4" />
            <span className="hidden sm:inline">Countdown</span>
          </TabsTrigger>
          <TabsTrigger value="triage" className="gap-1 sm:gap-2 px-2 sm:px-3" data-testid="tab-triage">
            <AlertTriangle className="h-4 w-4" />
            <span className="hidden sm:inline">Triage</span>
            {untriagedEpisodes && untriagedEpisodes.filter((ep: any) => ep.episode.airdate && !hiddenEpisodes.has(ep.episode.id)).length > 0 && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0">
                {untriagedEpisodes.filter((ep: any) => ep.episode.airdate && !hiddenEpisodes.has(ep.episode.id)).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="discover" className="gap-1 sm:gap-2 px-2 sm:px-3" data-testid="tab-discover">
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Discover</span>
            {visibleNewReleases.length > 0 && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0">
                {visibleNewReleases.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="countdown" className="space-y-8">
          <CountdownTimer showMode={showMode} />
        </TabsContent>

        <TabsContent value="queue" className="space-y-8">
        {/* Next to Watch Section */}
        <section>
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
              <PlayCircle className="w-4 h-4 text-white" />
            </div>
            <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-next-up">Next Up</h2>
            <p className="hidden sm:inline text-muted-foreground text-base ml-4 shrink-0">Your priority viewing queue</p>
          </div>
          
          <div className="space-y-4">
            {nextLoading ? (
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
                      <div className="flex gap-2">
                        <div className="h-8 bg-muted rounded w-20"></div>
                        <div className="h-8 bg-muted rounded w-16"></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : getNextEpisodesByShow.length > 0 ? (
              <div className="space-y-4">
                {getNextEpisodesByShow.map((userEpisode) => (
                  <EpisodeCard
                    key={userEpisode.id}
                    userEpisode={userEpisode}
                    onStatusChange={handleNextEpisodeStatusChange}
                    variant="wide"
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <PlayCircle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold text-muted-foreground mb-2">No episodes queued</h3>
                <p className="text-muted-foreground">Mark episodes as "Next" to build your viewing queue</p>
              </div>
            )}
          </div>
        </section>

        {/* Watch Later Section */}
        <section>
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
              <Clock className="w-4 h-4 text-white" />
            </div>
            <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-watch-later">Watch Later</h2>
            <p className="hidden sm:inline text-muted-foreground text-base ml-4 shrink-0">Episodes saved for later</p>
          </div>
          
          <div className="space-y-4">
            {laterLoading ? (
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
                      <div className="flex gap-2">
                        <div className="h-8 bg-muted rounded w-20"></div>
                        <div className="h-8 bg-muted rounded w-16"></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : getLaterEpisodesByShow.length > 0 ? (
              <div className="space-y-4">
                {getLaterEpisodesByShow.map((userEpisode) => (
                  <EpisodeCard
                    key={userEpisode.id}
                    userEpisode={userEpisode}
                    onStatusChange={handleLaterEpisodeStatusChange}
                    variant="wide"
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Clock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold text-muted-foreground mb-2" data-testid="text-no-watch-later">No episodes for later</h3>
                <p className="text-muted-foreground">Episodes you mark as "Later" will appear here</p>
              </div>
            )}
          </div>
        </section>

        </TabsContent>

        <TabsContent value="triage" className="space-y-8">
        {/* New in Feed Section (Triage) */}
        <section>
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-white" />
            </div>
            <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-new-feed">New in Feed</h2>
            <p className="hidden sm:inline text-muted-foreground text-base ml-4 shrink-0">Episodes that need your attention</p>
          </div>
          
          <div className="space-y-4">
            {untriagedLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className="w-full sm:w-32 h-48 sm:h-24 bg-muted rounded-md flex-shrink-0"></div>
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-muted rounded"></div>
                      <div className="h-3 bg-muted rounded w-3/4"></div>
                      <div className="h-3 bg-muted rounded w-1/2"></div>
                    </div>
                    <div className="flex gap-2">
                      <div className="h-8 bg-muted rounded w-20"></div>
                      <div className="h-8 bg-muted rounded w-16"></div>
                      <div className="h-8 bg-muted rounded w-20"></div>
                    </div>
                  </div>
                </div>
              ))
            ) : Object.keys(groupEpisodesByShowAndSeason).length > 0 ? (
              Object.entries(groupEpisodesByShowAndSeason)
                .sort(([, a], [, b]) => a.show.name.localeCompare(b.show.name))
                .map(([showId, showData]) => {
                  const visibleSeasons = getVisibleSeasonsForShow(showId, showData);
                  
                  const hasVisibleEpisodes = visibleSeasons.some((season: number) => {
                    const seasonEpisodes = showData.seasons[season] || [];
                    return seasonEpisodes.some(ep => !hiddenEpisodes.has(ep.episode.id) && ep.episode.airdate);
                  });
                  
                  if (!hasVisibleEpisodes) return null;
                  
                  const showSharingInfo = getShowSharingStatus(parseInt(showId));
                  
                  return (
                    <div key={showId} className="space-y-4">
                      {/* Show Title with Sharing Status */}
                      <div className="flex items-center justify-between border-b border-border pb-2">
                        <Link href={`/show/${showId}`}>
                          <h3 className="text-lg font-semibold text-foreground hover:text-primary transition-colors cursor-pointer">
                            {showData.show.name}
                          </h3>
                        </Link>
                        
                        {/* Sharing Status and Controls */}
                        <div className="flex items-center space-x-3">
                          {showSharingInfo.isShared !== undefined ? (
                            <Badge 
                              variant={showSharingInfo.isShared ? "default" : "secondary"}
                              className="flex items-center space-x-1"
                            >
                              {showSharingInfo.isShared ? (
                                <Share className="w-3 h-3" />
                              ) : (
                                <User className="w-3 h-3" />
                              )}
                              <span>{showSharingInfo.isShared ? 'Shared' : 'Personal'}</span>
                            </Badge>
                          ) : (
                            <div className="flex items-center space-x-2">
                              <span className="text-xs text-muted-foreground">Set as:</span>
                              <Select
                                onValueChange={(value) => {
                                  const isShared = value === 'shared';
                                  updateShowSharingMutation.mutate({
                                    showId: parseInt(showId),
                                    isShared
                                  });
                                }}
                                disabled={updateShowSharingMutation.isPending}
                              >
                                <SelectTrigger className="w-auto h-8 text-xs">
                                  <SelectValue placeholder="Choose..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="personal">Personal</SelectItem>
                                  <SelectItem value="shared">Shared</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      {/* Seasons */}
                      <div className="space-y-6">
                        {visibleSeasons.map((season: number) => {
                          const seasonEpisodes = showData.seasons[season] || [];
                          const visibleEpisodes = seasonEpisodes.filter(ep => !hiddenEpisodes.has(ep.episode.id) && ep.episode.airdate);
                          
                          if (visibleEpisodes.length === 0) return null;
                          
                          return (
                            <div key={season} className="space-y-3">
                              {/* Season Header */}
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-4">
                                  <h4 className="text-md font-medium text-muted-foreground">
                                    Season {season}
                                  </h4>
                                  <div className="text-sm text-muted-foreground">
                                    {visibleEpisodes.length} episode{visibleEpisodes.length !== 1 ? 's' : ''}
                                  </div>
                                </div>
                                
                                {/* Bulk Action Buttons */}
                                <div className="flex items-center space-x-1">
                                  <span className="text-xs text-muted-foreground mr-2 hidden sm:inline">Mark all:</span>
                                  <Button 
                                    size="sm" 
                                    variant="outline"
                                    onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "next")}
                                    data-testid={`button-bulk-next-${showId}-${season}`}
                                    className="h-7 px-2 text-xs hover:bg-green-50 hover:text-green-700 hover:border-green-300"
                                    title="Mark season as Next"
                                  >
                                    <Play className="w-3 h-3 sm:mr-1" />
                                    <span className="hidden sm:inline">Next</span>
                                  </Button>
                                  <Button 
                                    size="sm" 
                                    variant="outline"
                                    onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "later")}
                                    data-testid={`button-bulk-later-${showId}-${season}`}
                                    className="h-7 px-2 text-xs hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300"
                                    title="Mark season as Later"
                                  >
                                    <Clock className="w-3 h-3 sm:mr-1" />
                                    <span className="hidden sm:inline">Later</span>
                                  </Button>
                                  <Button 
                                    size="sm" 
                                    variant="outline"
                                    onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "watched")}
                                    data-testid={`button-bulk-watched-${showId}-${season}`}
                                    className="h-7 px-2 text-xs hover:bg-purple-50 hover:text-purple-700 hover:border-purple-300"
                                    title="Mark season as Watched"
                                  >
                                    <Eye className="w-3 h-3 sm:mr-1" />
                                    <span className="hidden sm:inline">Watched</span>
                                  </Button>
                                  <Button 
                                    size="sm" 
                                    variant="outline"
                                    onClick={() => handleBulkSeasonStatusChange(visibleEpisodes, "skipped")}
                                    data-testid={`button-bulk-skipped-${showId}-${season}`}
                                    className="h-7 px-2 text-xs hover:bg-red-50 hover:text-red-700 hover:border-red-300"
                                    title="Mark season as Skipped"
                                  >
                                    <SkipForward className="w-3 h-3 sm:mr-1" />
                                    <span className="hidden sm:inline">Skipped</span>
                                  </Button>
                                </div>
                              </div>
                              
                              {/* Episodes */}
                              <div className="space-y-3">
                                {visibleEpisodes.map((userEpisode) => (
                                  <EpisodeCard
                                    key={userEpisode.id}
                                    userEpisode={userEpisode}
                                    onStatusChange={handleTriageEpisodeStatusChange}
                                    variant="wide"
                                  />
                                ))}
                              </div>
                              
                              {/* Load Earlier Season Button */}
                              {season === Math.min(...visibleSeasons) && 
                               showData.allSeasons.some((s: number) => s < season) && (() => {
                                 const nextOlderSeason = showData.allSeasons.find((s: number) => s < season);
                                 return (
                                   <div className="flex justify-center pt-2">
                                     <Button 
                                       variant="outline" 
                                       size="sm"
                                       onClick={() => loadEarlierSeason(showId, visibleSeasons, showData.allSeasons)}
                                       data-testid={`button-load-earlier-season-${showId}`}
                                       className="text-muted-foreground hover:text-foreground"
                                     >
                                       <ChevronDown className="w-4 h-4 mr-2" />
                                       Load Season {nextOlderSeason}
                                     </Button>
                                   </div>
                                 );
                               })()}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
                .filter(Boolean)
            ) : (
              <div className="text-center py-8">
                <AlertTriangle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold text-muted-foreground mb-2">No new episodes</h3>
                <p className="text-muted-foreground">New episodes will appear here for triage</p>
              </div>
            )}
          </div>
        </section>

        </TabsContent>

        <TabsContent value="discover" className="space-y-8">
        {/* New Releases Section */}
        <section>
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
              <Calendar className="w-4 h-4 text-white" />
            </div>
            <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-new-releases">New Shows</h2>
            <Button
              onClick={() => newReleaseRefreshMutation.mutate()}
              disabled={newReleaseRefreshMutation.isPending}
              variant="outline"
              size="sm"
              data-testid="button-refresh-new-releases"
            >
              {newReleaseRefreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>

          <div className="space-y-4">
            {newReleasesLoading || newReleaseRefreshMutation.isPending ? (
              <Card className="p-12 text-center">
                <Loader2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-spin" />
                <h3 className="text-xl font-semibold mb-2">Fetching new releases...</h3>
                <p className="text-muted-foreground">
                  Checking TV schedules for new show premieres.
                </p>
              </Card>
            ) : visibleNewReleases.length === 0 ? (
              <div className="text-center py-8">
                <Calendar className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold text-muted-foreground mb-2" data-testid="text-no-new-releases">No new shows</h3>
                <p className="text-muted-foreground">Check back later for newly premiered shows</p>
              </div>
            ) : (
              <div className="space-y-4">
                {visibleNewReleases.map((show) => (
                  <Card
                    key={show.id}
                    className="overflow-hidden"
                    data-testid={`card-new-release-${show.id}`}
                  >
                    <div className="flex flex-col sm:flex-row">
                      {(show.image?.original || show.image?.medium) && (
                        <img
                          src={show.image.medium || show.image.original}
                          alt={show.name}
                          className="w-full sm:w-24 h-48 sm:h-auto object-cover flex-shrink-0"
                          data-testid={`img-poster-${show.id}`}
                        />
                      )}
                      <div className="p-4 flex-1 flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-lg mb-1" data-testid={`text-show-name-${show.id}`}>
                            {show.name}
                          </h3>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <span data-testid={`text-premiere-${show.id}`}>
                              📅 {formatPremiereDate(show.premiered)}
                            </span>
                            {(show.network || show.webChannel) && (
                              <span>• {show.network || show.webChannel}</span>
                            )}
                          </div>
                          {show.summary && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                              {stripHtml(show.summary)}
                            </p>
                          )}
                          {show.genres && show.genres.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {show.genres.slice(0, 3).map((genre) => (
                                <Badge key={genre} variant="secondary" className="text-xs">
                                  {genre}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <Button
                            onClick={() => newReleaseAddMutation.mutate(show)}
                            disabled={newReleaseProcessingId === show.id}
                            size="sm"
                            data-testid={`button-add-${show.id}`}
                          >
                            {newReleaseProcessingId === show.id ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Plus className="h-4 w-4 mr-1" />
                            )}
                            Add
                          </Button>
                          <Button
                            onClick={() => newReleaseDismissMutation.mutate(show.id)}
                            disabled={newReleaseDismissMutation.isPending}
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            data-testid={`button-dismiss-${show.id}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Recommendations Section */}
        <section>
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-6 h-6 bg-purple-500 rounded-full flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <h2 className="flex-1 min-w-0 text-2xl sm:text-3xl font-bold truncate" data-testid="text-section-title-recommendations">You Might Also Like...</h2>
            <Button
              onClick={() => recRefreshMutation.mutate()}
              disabled={recRefreshMutation.isPending}
              variant="outline"
              size="sm"
              data-testid="button-refresh-recommendations"
            >
              {recRefreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>

          <div className="space-y-4">
            {recommendationsLoading || recRefreshMutation.isPending ? (
              <Card className="p-12 text-center">
                <Loader2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-spin" />
                <h3 className="text-xl font-semibold mb-2">Generating recommendations...</h3>
                <p className="text-muted-foreground">
                  Analyzing your library to find the best matches.
                </p>
              </Card>
            ) : visibleRecommendations.length === 0 ? (
              <div className="text-center py-8">
                <Sparkles className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold text-muted-foreground mb-2" data-testid="text-no-recommendations">Nothing to suggest yet</h3>
                <p className="text-muted-foreground mb-4">Add more shows to your library to get personalized recommendations</p>
                <Button
                  onClick={() => recRefreshMutation.mutate()}
                  disabled={recRefreshMutation.isPending}
                  data-testid="button-generate-recommendations"
                >
                  {recRefreshMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Generate Recommendations
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {visibleRecommendations.map((rec) => (
                  <Card
                    key={rec.id}
                    className="overflow-hidden"
                    data-testid={`card-recommendation-${rec.tmdbId}`}
                  >
                    <div className="flex flex-col sm:flex-row">
                      {rec.posterPath && (
                        <img
                          src={`https://image.tmdb.org/t/p/w154${rec.posterPath}`}
                          alt={rec.name}
                          className="w-full sm:w-24 h-48 sm:h-auto object-cover flex-shrink-0"
                          data-testid={`img-rec-poster-${rec.tmdbId}`}
                        />
                      )}
                      <div className="p-4 flex-1 flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-lg mb-1" data-testid={`text-rec-show-name-${rec.tmdbId}`}>
                            {rec.name}
                          </h3>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1 flex-wrap">
                            {rec.voteAverage && (
                              <span data-testid={`text-rec-rating-${rec.tmdbId}`}>
                                ⭐ {(rec.voteAverage / 10).toFixed(1)}
                              </span>
                            )}
                            {rec.network && (
                              <span data-testid={`text-rec-network-${rec.tmdbId}`}>📺 {rec.network}</span>
                            )}
                            {rec.firstAirDate && (
                              <span>• {new Date(rec.firstAirDate).getFullYear()}</span>
                            )}
                          </div>
                          {rec.overview && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                              {rec.overview}
                            </p>
                          )}
                          {rec.genres && rec.genres.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {rec.genres.slice(0, 3).map((genre) => (
                                <Badge key={genre} variant="secondary" className="text-xs">
                                  {genre}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <Button
                            onClick={() => recAcceptMutation.mutate({ tmdbId: rec.tmdbId, showName: rec.name })}
                            disabled={recProcessingTmdbId === rec.tmdbId}
                            size="sm"
                            data-testid={`button-rec-accept-${rec.tmdbId}`}
                          >
                            {recProcessingTmdbId === rec.tmdbId ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Plus className="h-4 w-4 mr-1" />
                            )}
                            Add
                          </Button>
                          <Button
                            onClick={() => recAcceptWatchedMutation.mutate({ tmdbId: rec.tmdbId, showName: rec.name })}
                            disabled={recProcessingTmdbId === rec.tmdbId}
                            variant="secondary"
                            size="sm"
                            data-testid={`button-rec-accept-watched-${rec.tmdbId}`}
                          >
                            {recProcessingTmdbId === rec.tmdbId ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <CheckCheck className="h-4 w-4 mr-1" />
                            )}
                            Watched
                          </Button>
                          <Button
                            onClick={() => recDismissMutation.mutate(rec.tmdbId)}
                            disabled={recDismissMutation.isPending}
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            data-testid={`button-rec-dismiss-${rec.tmdbId}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </section>

        </TabsContent>
      </Tabs>
    </div>
  );
}
