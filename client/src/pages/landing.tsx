import { Button } from "@/components/ui/button";
import { Tv, Users, Clock, Sparkles } from "lucide-react";

export default function Landing() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="h-14 border-b border-border bg-card flex items-center px-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <Tv className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold">Front Row</span>
        </div>
        <div className="ml-auto">
          <a href="/api/login">
            <Button>Sign In</Button>
          </a>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-4xl w-full">
          <div className="text-center mb-12">
            <h1 className="text-4xl sm:text-5xl font-bold mb-4">
              Your TV Shows, <span className="text-primary">Organized</span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Track what you're watching, discover new shows, and share your viewing with family and friends.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
            <div className="bg-card rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Clock className="w-6 h-6 text-green-500" />
              </div>
              <h3 className="font-semibold mb-2">Track Episodes</h3>
              <p className="text-sm text-muted-foreground">
                Never lose your place. Track watched episodes across all your shows.
              </p>
            </div>

            <div className="bg-card rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Users className="w-6 h-6 text-blue-500" />
              </div>
              <h3 className="font-semibold mb-2">Share with Groups</h3>
              <p className="text-sm text-muted-foreground">
                Create groups with family or friends to manage shared watchlists.
              </p>
            </div>

            <div className="bg-card rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Tv className="w-6 h-6 text-orange-500" />
              </div>
              <h3 className="font-semibold mb-2">Countdown</h3>
              <p className="text-sm text-muted-foreground">
                See when your favorite shows return with upcoming episode countdowns.
              </p>
            </div>

            <div className="bg-card rounded-lg p-6 text-center">
              <div className="w-12 h-12 bg-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-6 h-6 text-purple-500" />
              </div>
              <h3 className="font-semibold mb-2">Discover</h3>
              <p className="text-sm text-muted-foreground">
                Get personalized recommendations based on what you love.
              </p>
            </div>
          </div>

          <div className="text-center">
            <a href="/api/login">
              <Button size="lg" className="text-lg px-8">
                Get Started with Google
              </Button>
            </a>
            <p className="text-sm text-muted-foreground mt-4">
              Free to use. No credit card required.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-6 px-6 text-center text-sm text-muted-foreground">
        Front Row - Your personal TV curator
      </footer>
    </div>
  );
}
