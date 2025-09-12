import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FloatingAddButtonProps {
  onClick: () => void;
}

export default function FloatingAddButton({ onClick }: FloatingAddButtonProps) {
  return (
    <Button
      onClick={onClick}
      data-testid="button-add-show"
      className="fixed bottom-6 right-6 w-14 h-14 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl shadow-lg transition-all duration-200 hover:scale-105 hover:shadow-xl"
      aria-label="Add new TV show"
    >
      <Plus className="w-8 h-8" />
    </Button>
  );
}
