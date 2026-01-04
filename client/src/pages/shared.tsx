import { Users } from "lucide-react";

export default function Shared() {
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="text-center py-16">
        <Users className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-xl font-semibold text-muted-foreground mb-2">Shared Viewing</h3>
        <p className="text-muted-foreground">Shows you're watching with friends and family</p>
      </div>
    </div>
  );
}
