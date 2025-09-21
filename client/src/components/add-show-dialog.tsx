import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tvmaze, TVMazeSearchResult } from "@/lib/tvmaze";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface AddShowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddShowDialog({ open, onOpenChange }: AddShowDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
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
      return apiRequest("POST", "/api/user/shows", {
        showId,
        status: "new",
      });
    },
    onSuccess: (data: any) => {
      // Invalidate multiple queries to refresh all sections
      queryClient.invalidateQueries({ queryKey: ["/api/user/shows"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/episodes"] });
      
      toast({
        title: "Show added",
        description: data.message || "The show has been added to your collection with all episodes imported.",
      });
      onOpenChange(false);
      setSearchQuery("");
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add show",
        variant: "destructive",
      });
    },
  });

  const handleAddShow = (showId: number) => {
    addShowMutation.mutate(showId);
  };

  const getImageUrl = (result: TVMazeSearchResult) => {
    if (result.show.image?.medium) {
      return result.show.image.medium;
    }
    return `https://via.placeholder.com/80x120/374151/9ca3af?text=${encodeURIComponent(result.show.name)}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add TV Show</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          {/* Search Input */}
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
                  disabled={addShowMutation.isPending}
                  data-testid={`button-add-show-${result.show.id}`}
                  className="flex-shrink-0"
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
