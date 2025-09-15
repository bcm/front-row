import { UserShow, Show } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Trash2 } from "lucide-react";
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
import { useState } from "react";

interface ShowCardProps {
  userShow: UserShow & { show: Show };
  variant?: "default" | "compact" | "priority";
  onRemove?: () => void; // Optional callback for when a show is removed
}

export default function ShowCard({ userShow, variant = "default", onRemove }: ShowCardProps) {
  const { show } = userShow;
  const { toast } = useToast();
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);

  // Remove show mutation
  const removeShowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", `/api/user/shows/${show.id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/library"] });
      toast({
        title: "Show removed",
        description: `"${show.name}" has been removed from your library and unfollowed on TVMaze.`,
      });
      setIsRemoveDialogOpen(false);
      if (onRemove) {
        onRemove();
      }
    },
    onError: (error: any) => {
      toast({
        title: "Remove failed",
        description: error.message || `Failed to remove "${show.name}"`,
        variant: "destructive",
      });
      setIsRemoveDialogOpen(false);
    },
  });

  const handleConfirmRemove = () => {
    removeShowMutation.mutate();
  };

  const getNetworkInfo = () => {
    if (show.webChannel?.name) {
      return show.webChannel.name;
    }
    if (show.network?.name) {
      return show.network.name;
    }
    return "Unknown Network";
  };

  if (variant === "compact") {
    return (
      <div className="show-card bg-card hover:bg-card/80 rounded-lg p-3 transition-all duration-200 cursor-pointer relative" data-testid={`card-show-${show.id}`}>
        <img 
          src={show.image?.medium || "/placeholder-show.jpg"}
          alt={`${show.name} poster`}
          className="w-full h-24 object-cover rounded-md mb-2"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = "https://via.placeholder.com/120x180/374151/9ca3af?text=" + encodeURIComponent(show.name);
          }}
        />
        <AlertDialog open={isRemoveDialogOpen} onOpenChange={setIsRemoveDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              onClick={(e) => e.stopPropagation()}
              className="absolute top-2 right-2 h-6 w-6 p-0"
              data-testid={`button-remove-show-${show.id}`}
            >
              <Trash2 className="h-3 w-3" />
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
        <Link href={`/show/${show.id}`}>
          <h3 className="font-medium text-sm truncate text-foreground hover:text-primary transition-colors" data-testid={`text-show-title-${show.id}`}>
            {show.name}
          </h3>
        </Link>
        <p className="text-xs text-muted-foreground" data-testid={`text-show-network-${show.id}`}>
          {getNetworkInfo()}
        </p>
      </div>
    );
  }

  if (variant === "priority") {
    return (
      <div 
        className="show-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200 cursor-pointer relative"
        data-testid={`card-show-${show.id}`}
      >
        <AlertDialog open={isRemoveDialogOpen} onOpenChange={setIsRemoveDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              onClick={(e) => e.stopPropagation()}
              className="absolute top-2 right-2 h-6 w-6 p-0"
              data-testid={`button-remove-show-${show.id}`}
            >
              <Trash2 className="h-3 w-3" />
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
        <div className="flex space-x-3 mb-4">
          <img 
            src={show.image?.medium || "/placeholder-show.jpg"}
            alt={`${show.name} poster`}
            className="w-12 h-16 object-cover rounded-md flex-shrink-0"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.src = "https://via.placeholder.com/80x120/374151/9ca3af?text=" + encodeURIComponent(show.name);
            }}
          />
          <div className="flex-1 min-w-0">
            <Link href={`/show/${show.id}`}>
              <h3 className="font-semibold text-foreground truncate hover:text-primary transition-colors" data-testid={`text-show-title-${show.id}`}>
                {show.name}
              </h3>
            </Link>
            <p className="text-sm text-muted-foreground mb-2" data-testid={`text-show-meta-${show.id}`}>
              {getNetworkInfo()} • {show.runtime ? `${show.runtime}min` : "Runtime unknown"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="show-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200 cursor-pointer relative" data-testid={`card-show-${show.id}`}>
      <AlertDialog open={isRemoveDialogOpen} onOpenChange={setIsRemoveDialogOpen}>
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            size="sm"
            onClick={(e) => e.stopPropagation()}
            className="absolute top-2 right-2 h-6 w-6 p-0"
            data-testid={`button-remove-show-${show.id}`}
          >
            <Trash2 className="h-3 w-3" />
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
      <div className="flex space-x-3 mb-4">
        <img 
          src={show.image?.medium || "/placeholder-show.jpg"}
          alt={`${show.name} poster`}
          className="w-12 h-16 object-cover rounded-md flex-shrink-0"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = "https://via.placeholder.com/80x120/374151/9ca3af?text=" + encodeURIComponent(show.name);
          }}
        />
        <div className="flex-1 min-w-0">
          <Link href={`/show/${show.id}`}>
            <h3 className="font-semibold text-foreground truncate hover:text-primary transition-colors" data-testid={`text-show-title-${show.id}`}>
              {show.name}
            </h3>
          </Link>
          <p className="text-sm text-muted-foreground mb-2" data-testid={`text-show-meta-${show.id}`}>
            {getNetworkInfo()} • {show.runtime ? `${show.runtime}min` : "Runtime unknown"}
          </p>
        </div>
      </div>
    </div>
  );
}
