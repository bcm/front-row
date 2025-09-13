import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { UserShow, Show } from "@shared/schema";
import Header from "@/components/header";
import ShowCard from "@/components/show-card";
import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { Star, Flame, Clock, Settings, Users, BookOpen } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import FollowedShows from "./followed-shows";

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: newShows, isLoading: newShowsLoading } = useQuery({
    queryKey: ["/api/user/shows", "new"],
    queryFn: async () => {
      const response = await fetch("/api/user/shows?status=new");
      if (!response.ok) throw new Error("Failed to fetch new shows");
      return response.json() as Promise<(UserShow & { show: Show })[]>;
    },
  });

  const { data: watchingShows, isLoading: watchingShowsLoading } = useQuery({
    queryKey: ["/api/user/shows", "watching"],
    queryFn: async () => {
      const response = await fetch("/api/user/shows?status=watching");
      if (!response.ok) throw new Error("Failed to fetch watching shows");
      return response.json() as Promise<(UserShow & { show: Show })[]>;
    },
  });

  const { data: laterShows, isLoading: laterShowsLoading } = useQuery({
    queryKey: ["/api/user/shows", "later"],
    queryFn: async () => {
      const response = await fetch("/api/user/shows?status=later");
      if (!response.ok) throw new Error("Failed to fetch later shows");
      return response.json() as Promise<(UserShow & { show: Show })[]>;
    },
  });

  const updateShowMutation = useMutation({
    mutationFn: async ({ showId, status, priority }: { showId: number; status: string; priority?: number }) => {
      const updates: any = { status };
      if (priority !== undefined) {
        updates.priority = priority;
      }
      
      return apiRequest("PATCH", `/api/user/shows/${showId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      toast({
        title: "Show updated",
        description: "The show status has been updated.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update show",
        variant: "destructive",
      });
    },
  });

  const handleStatusChange = (showId: number, status: string) => {
    const priority = status === "watching" ? 1 : 0;
    updateShowMutation.mutate({ showId, status, priority });
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case "dashboard":
        return (
          <div className="space-y-10">
            {/* New in Feed Section */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-3">
                  <div className="w-6 h-6 bg-primary rounded-full flex items-center justify-center">
                    <Star className="w-4 h-4 text-primary-foreground" />
                  </div>
                  <h2 className="text-2xl font-bold" data-testid="text-section-title-new-feed">New in Feed</h2>
                  <span className="bg-primary text-primary-foreground px-2 py-1 rounded-full text-xs font-bold" data-testid="text-new-feed-count">
                    {newShows?.length || 0}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">New releases and announcements</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {newShowsLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                      <div className="flex space-x-3 mb-4">
                        <div className="w-12 h-16 bg-muted rounded-md"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-4 bg-muted rounded"></div>
                          <div className="h-3 bg-muted rounded w-3/4"></div>
                          <div className="h-5 bg-muted rounded w-1/2"></div>
                        </div>
                      </div>
                      <div className="flex space-x-2">
                        <div className="flex-1 h-8 bg-muted rounded"></div>
                        <div className="flex-1 h-8 bg-muted rounded"></div>
                        <div className="flex-1 h-8 bg-muted rounded"></div>
                      </div>
                    </div>
                  ))
                ) : newShows && newShows.length > 0 ? (
                  newShows.map((userShow) => (
                    <ShowCard
                      key={userShow.id}
                      userShow={userShow}
                      onStatusChange={handleStatusChange}
                    />
                  ))
                ) : (
                  <div className="col-span-full text-center py-8">
                    <Flame className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-lg font-semibold text-muted-foreground mb-2">No new shows</h3>
                    <p className="text-muted-foreground">Add some shows to get started!</p>
                  </div>
                )}
              </div>
            </section>

            {/* Watch Next Queue */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-3">
                  <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                    <Flame className="w-4 h-4 text-white" />
                  </div>
                  <h2 className="text-2xl font-bold" data-testid="text-section-title-watch-next">Watch Next</h2>
                  <span className="bg-green-500 text-white px-2 py-1 rounded-full text-xs font-bold" data-testid="text-watch-next-count">
                    {watchingShows?.length || 0}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">Your priority queue</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {watchingShowsLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="bg-card rounded-lg p-4 animate-pulse">
                      <div className="flex space-x-3 mb-4">
                        <div className="w-12 h-16 bg-muted rounded-md"></div>
                        <div className="flex-1 space-y-2">
                          <div className="h-4 bg-muted rounded"></div>
                          <div className="h-3 bg-muted rounded w-3/4"></div>
                          <div className="h-5 bg-muted rounded w-1/2"></div>
                        </div>
                      </div>
                      <div className="flex space-x-2">
                        <div className="flex-1 h-8 bg-muted rounded"></div>
                        <div className="flex-1 h-8 bg-muted rounded"></div>
                      </div>
                    </div>
                  ))
                ) : watchingShows && watchingShows.length > 0 ? (
                  watchingShows
                    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                    .map((userShow) => (
                      <ShowCard
                        key={userShow.id}
                        userShow={userShow}
                        onStatusChange={handleStatusChange}
                        variant="priority"
                      />
                    ))
                ) : (
                  <div className="col-span-full text-center py-8">
                    <Clock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-lg font-semibold text-muted-foreground mb-2">No shows in queue</h3>
                    <p className="text-muted-foreground">Move some shows to your watch queue!</p>
                  </div>
                )}
              </div>
            </section>

            {/* Watch Later */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-3">
                  <div className="w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center">
                    <Clock className="w-4 h-4 text-white" />
                  </div>
                  <h2 className="text-2xl font-bold" data-testid="text-section-title-watch-later">Watch Later</h2>
                  <span className="bg-yellow-500 text-black px-2 py-1 rounded-full text-xs font-bold" data-testid="text-watch-later-count">
                    {laterShows?.length || 0}
                  </span>
                </div>
                <button className="text-muted-foreground hover:text-foreground text-sm transition-colors" data-testid="button-view-all-later">
                  View All
                </button>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                {laterShowsLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="bg-card rounded-lg p-3 animate-pulse">
                      <div className="w-full h-24 bg-muted rounded-md mb-2"></div>
                      <div className="h-3 bg-muted rounded mb-1"></div>
                      <div className="h-2 bg-muted rounded w-2/3"></div>
                    </div>
                  ))
                ) : laterShows && laterShows.length > 0 ? (
                  laterShows.slice(0, 8).map((userShow) => (
                    <ShowCard
                      key={userShow.id}
                      userShow={userShow}
                      onStatusChange={handleStatusChange}
                      variant="compact"
                    />
                  ))
                ) : (
                  <div className="col-span-full text-center py-8">
                    <Clock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <h3 className="text-lg font-semibold text-muted-foreground mb-2">No shows saved for later</h3>
                    <p className="text-muted-foreground">Shows you mark as "Later" will appear here</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        );

      case "followed":
        return <FollowedShows />;

      case "library":
        return (
          <div className="text-center py-16">
            <BookOpen className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold text-muted-foreground mb-2">Library Management</h3>
            <p className="text-muted-foreground">Browse and organize your complete TV show collection</p>
          </div>
        );

      case "shared":
        return (
          <div className="text-center py-16">
            <Users className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold text-muted-foreground mb-2">Shared Viewing</h3>
            <p className="text-muted-foreground">Shows you're watching with friends and family</p>
          </div>
        );

      case "settings":
        return (
          <div className="text-center py-16">
            <Settings className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold text-muted-foreground mb-2">Settings</h3>
            <p className="text-muted-foreground">Customize your Front Row experience</p>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header 
        activeTab={activeTab} 
        onTabChange={setActiveTab}
      />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {renderTabContent()}
      </main>

      <FloatingAddButton onClick={() => setShowAddDialog(true)} />
      
      <AddShowDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
      />
    </div>
  );
}
