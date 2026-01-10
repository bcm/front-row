import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Users, Check, X, Loader2 } from "lucide-react";

interface InviteInfo {
  invite: {
    id: string;
    groupId: string;
    inviteCode: string;
  };
  group: {
    id: string;
    name: string;
    description: string | null;
  };
}

export default function Join() {
  const { inviteCode } = useParams<{ inviteCode: string }>();
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: inviteInfo, isLoading, error } = useQuery<InviteInfo>({
    queryKey: ["/api/invites", inviteCode],
    queryFn: async () => {
      const response = await fetch(`/api/invites/${inviteCode}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Invalid invite");
      }
      return response.json();
    },
    enabled: !!inviteCode,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/invites/${inviteCode}/accept`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      toast({ title: "Successfully joined the group!" });
      setLocation("/shared");
    },
    onError: (error: Error) => {
      toast({ title: error.message || "Failed to join group", variant: "destructive" });
    },
  });

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <Users className="w-12 h-12 mx-auto text-primary mb-2" />
            <CardTitle>Sign in to Join</CardTitle>
            <CardDescription>
              You need to sign in to accept this group invitation.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild className="w-full">
              <a href="/api/login">Sign in with Google</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <X className="w-12 h-12 mx-auto text-destructive mb-2" />
            <CardTitle>Invalid Invitation</CardTitle>
            <CardDescription>
              {(error as Error).message || "This invite link is invalid, expired, or has already been used."}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => setLocation("/shared")}>
              Go to Groups
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!inviteInfo) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <Users className="w-12 h-12 mx-auto text-primary mb-2" />
          <CardTitle>Join {inviteInfo.group.name}</CardTitle>
          {inviteInfo.group.description && (
            <CardDescription>{inviteInfo.group.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-muted-foreground">
            You've been invited to join this group for shared TV show watching.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setLocation("/shared")}
            >
              Decline
            </Button>
            <Button
              className="flex-1"
              onClick={() => acceptMutation.mutate()}
              disabled={acceptMutation.isPending}
            >
              {acceptMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Check className="w-4 h-4 mr-2" />
              )}
              Accept & Join
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
