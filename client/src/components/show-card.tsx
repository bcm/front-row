import { UserShow, Show } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

interface ShowCardProps {
  userShow: UserShow & { show: Show };
  onStatusChange: (showId: number, status: string) => void;
  variant?: "default" | "compact" | "priority";
}

export default function ShowCard({ userShow, onStatusChange, variant = "default" }: ShowCardProps) {
  const { show } = userShow;

  const getStatusBadge = (status: string) => {
    if (status === "new") {
      return <Badge className="bg-primary/20 text-primary border border-primary/30">NEW EPISODE</Badge>;
    }
    if (status === "watching") {
      return <Badge className="bg-green-500/20 text-green-400 border border-green-500/30">WATCHING</Badge>;
    }
    return <Badge className="bg-purple-500/20 text-purple-400 border border-purple-500/30">LATER</Badge>;
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
      <div className="show-card bg-card hover:bg-card/80 rounded-lg p-3 transition-all duration-200 cursor-pointer" data-testid={`card-show-${show.id}`}>
        <img 
          src={show.image?.medium || "/placeholder-show.jpg"}
          alt={`${show.name} poster`}
          className="w-full h-24 object-cover rounded-md mb-2"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = "https://via.placeholder.com/120x180/374151/9ca3af?text=" + encodeURIComponent(show.name);
          }}
        />
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
        className="show-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200 cursor-pointer"
        data-testid={`card-show-${show.id}`}
      >
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
            {getStatusBadge(userShow.status)}
          </div>
        </div>
        <div className="flex space-x-2">
          <Button 
            size="sm" 
            className="flex-1 text-xs font-semibold uppercase"
            onClick={() => onStatusChange(show.id, "watching")}
            data-testid={`button-watch-${show.id}`}
          >
            Watch
          </Button>
          <Button 
            size="sm" 
            variant="secondary" 
            className="flex-1 text-xs font-semibold uppercase"
            onClick={() => onStatusChange(show.id, "later")}
            data-testid={`button-later-${show.id}`}
          >
            Later
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="show-card bg-card hover:bg-card/80 rounded-lg p-4 transition-all duration-200 cursor-pointer" data-testid={`card-show-${show.id}`}>
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
          {getStatusBadge(userShow.status)}
        </div>
      </div>
      <div className="flex space-x-2">
        <Button 
          size="sm" 
          className="flex-1 text-xs font-semibold uppercase"
          onClick={() => onStatusChange(show.id, "watching")}
          data-testid={`button-next-${show.id}`}
        >
          Next
        </Button>
        <Button 
          size="sm" 
          variant="secondary" 
          className="flex-1 text-xs font-semibold uppercase"
          onClick={() => onStatusChange(show.id, "later")}
          data-testid={`button-later-${show.id}`}
        >
          Later
        </Button>
        <Button 
          size="sm" 
          variant="destructive" 
          className="flex-1 text-xs font-semibold uppercase"
          onClick={() => onStatusChange(show.id, "archived")}
          data-testid={`button-archive-${show.id}`}
        >
          Archive
        </Button>
      </div>
    </div>
  );
}
