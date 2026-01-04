import FloatingAddButton from "@/components/floating-add-button";
import AddShowDialog from "@/components/add-show-dialog";
import { Settings } from "lucide-react";
import { useState } from "react";

export default function SettingsPage() {
  const [showAddDialog, setShowAddDialog] = useState(false);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="text-center py-16">
        <Settings className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-xl font-semibold text-muted-foreground mb-2">Settings</h3>
        <p className="text-muted-foreground">Customize your Front Row experience</p>
      </div>

      <FloatingAddButton onClick={() => setShowAddDialog(true)} />
      
      <AddShowDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
      />
    </div>
  );
}