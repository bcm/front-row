import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { 
  Users, 
  Plus, 
  Copy, 
  Check, 
  UserPlus,
  Crown,
  LogOut,
  Trash2,
  Mail,
  Loader2,
  Link as LinkIcon,
  Clock,
} from "lucide-react";

interface Group {
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  memberCount: number;
  createdAt: string;
}

interface GroupMember {
  id: string;
  userId: string;
  groupId: string;
  joinedAt: string;
  user: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
  };
}

interface GroupInvite {
  id: string;
  groupId: string;
  inviteCode: string;
  invitedEmail: string | null;
  expiresAt: string | null;
  createdAt: string;
  group?: Group;
}

interface GroupWithDetails extends Group {
  members: GroupMember[];
  invites: GroupInvite[];
}

export default function Shared() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDescription, setNewGroupDescription] = useState("");
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const { data: groups = [], isLoading: groupsLoading } = useQuery<GroupWithDetails[]>({
    queryKey: ["/api/groups"],
    queryFn: async () => {
      const response = await fetch('/api/groups');
      if (!response.ok) throw new Error('Failed to fetch groups');
      const groupList = await response.json();
      
      const groupsWithDetails = await Promise.all(
        groupList.map(async (group: Group) => {
          try {
            const detailResponse = await fetch(`/api/groups/${group.id}`);
            if (detailResponse.ok) {
              const details = await detailResponse.json();
              const invitesResponse = await fetch(`/api/groups/${group.id}/invites`);
              const invites = invitesResponse.ok ? await invitesResponse.json() : [];
              return { ...details, invites };
            }
          } catch (e) {
            console.error('Failed to fetch group details:', e);
          }
          return { ...group, members: [], invites: [] };
        })
      );
      return groupsWithDetails;
    },
  });

  const { data: pendingInvites = [] } = useQuery<GroupInvite[]>({
    queryKey: ["/api/invites/pending"],
  });

  const createGroupMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const response = await apiRequest("POST", "/api/groups", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      setCreateDialogOpen(false);
      setNewGroupName("");
      setNewGroupDescription("");
      toast({ title: "Group created successfully!" });
    },
    onError: () => {
      toast({ title: "Failed to create group", variant: "destructive" });
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const response = await apiRequest("POST", `/api/groups/${groupId}/invites`, { expiresInDays: 7 });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      toast({ title: "Invite link created!" });
    },
    onError: () => {
      toast({ title: "Failed to create invite", variant: "destructive" });
    },
  });

  const acceptInviteMutation = useMutation({
    mutationFn: async (inviteCode: string) => {
      const response = await apiRequest("POST", `/api/invites/${inviteCode}/accept`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/invites/pending"] });
      toast({ title: "Joined group successfully!" });
    },
    onError: () => {
      toast({ title: "Failed to join group", variant: "destructive" });
    },
  });

  const leaveGroupMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const response = await apiRequest("DELETE", `/api/groups/${groupId}/members/me`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      toast({ title: "Left group successfully" });
    },
    onError: () => {
      toast({ title: "Failed to leave group", variant: "destructive" });
    },
  });

  const copyInviteLink = (invite: GroupInvite) => {
    const fullUrl = `${window.location.origin}/join/${invite.inviteCode}`;
    navigator.clipboard.writeText(fullUrl);
    setCopiedInviteId(invite.id);
    setTimeout(() => setCopiedInviteId(null), 2000);
    toast({ title: "Invite link copied!" });
  };

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;
    createGroupMutation.mutate({
      name: newGroupName.trim(),
      description: newGroupDescription.trim(),
    });
  };

  const getInitials = (member: GroupMember["user"]) => {
    if (member.firstName && member.lastName) {
      return `${member.firstName[0]}${member.lastName[0]}`.toUpperCase();
    }
    if (member.firstName) return member.firstName[0].toUpperCase();
    if (member.email) return member.email[0].toUpperCase();
    return "?";
  };

  const getMemberName = (member: GroupMember["user"]) => {
    if (member.firstName && member.lastName) {
      return `${member.firstName} ${member.lastName}`;
    }
    if (member.firstName) return member.firstName;
    return member.email || "Unknown";
  };

  const formatExpiryDate = (expiresAt: string | null) => {
    if (!expiresAt) return "Never expires";
    const date = new Date(expiresAt);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return "Expired";
    if (diffDays === 1) return "Expires tomorrow";
    return `Expires in ${diffDays} days`;
  };

  if (groupsLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Groups</h1>
          <p className="text-muted-foreground">Manage groups for watching shows together</p>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Create Group
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a New Group</DialogTitle>
              <DialogDescription>
                Create a group to share shows and track episodes with friends and family.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Group Name</Label>
                <Input
                  id="name"
                  placeholder="e.g., Family, Roommates, Watch Club"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Input
                  id="description"
                  placeholder="What shows will you watch together?"
                  value={newGroupDescription}
                  onChange={(e) => setNewGroupDescription(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim() || createGroupMutation.isPending}
              >
                {createGroupMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                Create Group
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {pendingInvites.length > 0 && (
        <Card className="mb-6 border-primary/50 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Mail className="w-5 h-5 text-primary" />
              Pending Invitations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {pendingInvites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex items-center justify-between p-3 bg-background rounded-lg border"
                >
                  <div>
                    <p className="font-medium">{invite.group?.name || "Unknown Group"}</p>
                    <p className="text-sm text-muted-foreground">
                      You've been invited to join this group
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => acceptInviteMutation.mutate(invite.inviteCode)}
                    disabled={acceptInviteMutation.isPending}
                  >
                    {acceptInviteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="w-4 h-4 mr-1" />
                        Accept
                      </>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {groups.length === 0 ? (
        <Card>
          <CardContent className="text-center py-16">
            <Users className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold text-muted-foreground mb-2">No Groups Yet</h3>
            <p className="text-muted-foreground mb-4">
              Create a group to start sharing shows with friends and family
            </p>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create Your First Group
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <Card key={group.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {group.name}
                      {group.createdBy === user?.id && (
                        <Badge variant="secondary" className="text-xs">
                          <Crown className="w-3 h-3 mr-1" />
                          Owner
                        </Badge>
                      )}
                    </CardTitle>
                    {group.description && (
                      <CardDescription className="mt-1">
                        {group.description}
                      </CardDescription>
                    )}
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                        {group.createdBy === user?.id ? (
                          <>
                            <Trash2 className="w-4 h-4 mr-1" />
                            Delete
                          </>
                        ) : (
                          <>
                            <LogOut className="w-4 h-4 mr-1" />
                            Leave
                          </>
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {group.createdBy === user?.id ? "Delete Group?" : "Leave Group?"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {group.createdBy === user?.id
                            ? "This will permanently delete the group and remove all members. This action cannot be undone."
                            : "You will no longer have access to this group's shared content."}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => leaveGroupMutation.mutate(group.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {group.createdBy === user?.id ? "Delete" : "Leave"}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    Members ({group.members?.length || 0})
                  </h4>
                  <div className="flex flex-wrap gap-3">
                    {group.members?.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center gap-2 p-2 rounded-lg bg-muted/50"
                      >
                        <Avatar className="w-8 h-8">
                          <AvatarImage src={member.user.profileImageUrl || undefined} />
                          <AvatarFallback className="text-xs">{getInitials(member.user)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="text-sm font-medium flex items-center gap-1">
                            {getMemberName(member.user)}
                            {member.userId === group.createdBy && (
                              <Crown className="w-3 h-3 text-yellow-500" />
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <LinkIcon className="w-4 h-4" />
                    Invite Links
                  </h4>
                  {group.invites && group.invites.length > 0 ? (
                    <div className="space-y-2">
                      {group.invites.map((invite) => (
                        <div
                          key={invite.id}
                          className="flex items-center gap-2 p-2 rounded-lg bg-muted/50"
                        >
                          <code className="flex-1 text-xs bg-background px-2 py-1 rounded truncate">
                            {window.location.origin}/join/{invite.inviteCode}
                          </code>
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatExpiryDate(invite.expiresAt)}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => copyInviteLink(invite)}
                          >
                            {copiedInviteId === invite.id ? (
                              <Check className="w-3 h-3 text-green-500" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No active invite links</p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => createInviteMutation.mutate(group.id)}
                    disabled={createInviteMutation.isPending}
                  >
                    {createInviteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <UserPlus className="w-4 h-4 mr-1" />
                    )}
                    Create New Invite Link
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
