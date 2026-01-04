import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import FollowedShows from "./followed-shows";
import { useState } from "react";

export default function Library() {
  const [showAddDialog, setShowAddDialog] = useState(false);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <FollowedShows />

      <FloatingAddButton onClick={() => setShowAddDialog(true)} />
      
      <AddShowDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
      />
    </div>
  );
}