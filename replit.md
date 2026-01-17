# TV Curator Application

## Overview

TV Curator is a full-stack web application for managing and tracking TV shows. It provides users with the ability to search for shows using the TVMaze API, add them to personal collections, and organize them by status (new, watching, later, archived). The application features a modern React frontend with shadcn/ui components and an Express.js backend with PostgreSQL database integration.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript using Vite for build tooling
- **UI Library**: shadcn/ui components built on Radix UI primitives
- **Styling**: Tailwind CSS with custom design system variables
- **State Management**: TanStack Query (React Query) for server state management
- **Routing**: Wouter for lightweight client-side routing with episode detail pages (`/episode/:id`)
- **Navigation**: Episode names throughout the app link to dedicated episode detail pages
- **Forms**: React Hook Form with Zod validation resolvers

### Backend Architecture
- **Server**: Express.js with TypeScript
- **Database**: PostgreSQL with Drizzle ORM for type-safe database operations
- **API Design**: RESTful endpoints with proxy routes to TVMaze API
- **Session Management**: Express sessions with PostgreSQL session store
- **Error Handling**: Centralized error handling middleware
- **Development**: Hot module replacement with Vite integration

### Database Schema
The application uses six main entities:
- **Users**: Authentication and user management
- **Shows**: TV show metadata from TVMaze API with TMDB ID mapping
- **UserShows**: Many-to-many relationship tracking user's show collections with status and timestamps (simplified from previous version)
- **Episodes**: Episode information linked to shows for tracking purposes
- **Recommendations**: Personalized show recommendations from TMDB's collaborative filtering API
- **DismissedRecommendations**: Tracks shows that users have dismissed from their recommendation feed

### Data Layer
- **Drizzle ORM**: Type-safe database queries with automatic TypeScript inference
- **Database Migrations**: Managed through Drizzle Kit
- **Storage Abstraction**: Interface-based storage layer supporting both in-memory and database implementations
- **Connection**: Neon serverless PostgreSQL connection

### API Integration
- **TVMaze API**: External service for show search, details, and episode information
- **Proxy Endpoints**: Server-side proxy routes to handle TVMaze API requests and avoid CORS issues
- **Caching Strategy**: TanStack Query provides client-side caching with configurable stale times

### Authentication & Authorization
Currently implemented with basic session-based authentication structure, though authentication routes are not fully implemented in the current codebase.

## In Progress: Shared Episode Status for Groups

### Context
When implementing multi-user groups (family/roommates), we decided that **group members should share a single episode status** rather than each person tracking their own progress. This means when one family member marks an episode as "watched", everyone in the group sees it as watched.

### Architectural Decision
- **Personal shows**: Each user has their own `user_episodes` records with their `userId`
- **Shared shows**: Group members share `user_episodes` records identified by `groupId`

### Schema Change Required
Add `groupId` column to `user_episodes` table:
```typescript
groupId: varchar("group_id"), // null = personal episode status, set = shared group status
```

### Logic Changes Required
1. **Storage layer - getUserEpisodes**: When fetching episodes for shared shows, query by `groupId` instead of `userId`
2. **Storage layer - status mutations**: When updating episode status for shared shows, update the group's record (by `groupId`)
3. **Episode sync**: When syncing episodes for shared shows, create records with `groupId` set (not `userId`)
4. **API routes**: Update endpoints to detect shared vs personal context and use appropriate queries

### Production Migration SQL
After publishing and creating user account + Family group:
```sql
-- Step 1: Assign ALL orphaned data to your user account (required for anything to work)
UPDATE user_shows SET user_id = 'YOUR_USER_ID';
UPDATE user_episodes SET user_id = 'YOUR_USER_ID';
UPDATE recommendations SET user_id = 'YOUR_USER_ID';

-- Step 2: Assign previously-shared SHOWS to Family group
UPDATE user_shows SET group_id = 'YOUR_FAMILY_GROUP_ID' WHERE is_shared = true;

-- Step 3: Create shared episode records for Family group shows
-- (This migrates episode status from personal to shared for shows in the group)
UPDATE user_episodes 
SET group_id = 'YOUR_FAMILY_GROUP_ID', user_id = NULL 
WHERE episode_id IN (
  SELECT e.id FROM episodes e 
  JOIN user_shows us ON e.show_id = us.show_id 
  WHERE us.group_id = 'YOUR_FAMILY_GROUP_ID'
);
```

### Key Files to Modify
- `shared/schema.ts` - Add groupId to user_episodes
- `server/storage.ts` - Update getUserEpisodes, updateUserEpisodeStatus, createUserEpisode
- `server/routes.ts` - Update episode API endpoints
- Dashboard and episode components - Should work without changes if storage layer handles correctly

## Recent Changes

### January 4, 2026
- **Unified Dashboard**: Consolidated all six sections (Countdown Timer, Next Up, Watch Later, New in Feed, New Releases, Recommendations) into a single Dashboard page
- **Simplified Navigation**: Replaced sidebar with top navigation bar containing Dashboard and Library links
- **Removed Settings Page**: Eliminated the empty settings page from routes

### October 28, 2025
- **TMDB Recommendations System**: Implemented complete recommendation engine using TMDB's collaborative filtering API
  - New `/recommendations` page with mobile-responsive card layout showing personalized show suggestions
  - Recommendations aggregated from user's library shows, scored by frequency, rating, and genre match
  - Added TMDB ID mapping for shows to enable cross-platform recommendations
  - Dismiss functionality to hide unwanted recommendations permanently
  - One-click accept to add recommended shows directly to library with automatic episode sync
  - New database tables: `recommendations` and `dismissed_recommendations`
  - Daily automated recommendation refresh at 4:00 AM Eastern Time
  - Navigation link added to header with Sparkles icon

### October 5, 2025
- **Cancelable Episode Sync**: Episode sync operations can now be canceled mid-process via a cancel button in the sync dialog
- **Automated Daily Sync**: Added standalone script (`scripts/daily-episode-sync.ts`) for automated daily episode syncing via Replit Scheduled Deployments
- **Finished Show Filtering**: Episode sync now automatically excludes shows with status "Ended" to improve efficiency
- **Security Improvements**: Removed Replit dev banner script from production HTML, added Content Security Policy header for HTTPS upgrade
- **UI Polish**: Fixed button labels, tooltips, and favicon implementation

### September 13, 2025
- **Episode Detail Page**: Added comprehensive episode detail page (`/episode/:id`) with full episode information, show context, and status management
- **Episode Linking**: All episode names throughout the application now link to their respective episode detail pages
- **Scrobble API Integration**: Enhanced show sync process to automatically apply user's personal watch status from TVMaze scrobble API
- **Status Management**: Complete episode status cycling functionality (UNWATCHED → NEXT → LATER → WATCHED → UNWATCHED) across all pages
- **Navigation Enhancement**: Improved navigation flows between dashboard, show details, and episode details with breadcrumb navigation
- **Database Cleanup**: Removed 5 unused columns from user_shows table (currentSeason, currentEpisode, watchedAt, priority, isShared) to simplify schema and improve performance

## External Dependencies

### Third-Party APIs
- **TVMaze API**: Primary data source for TV show information, search functionality, and episode data
- **TVMaze Scrobble API**: User watch status consultation for automatic status synchronization during show imports
- **TMDB API**: The Movie Database API for collaborative filtering recommendations and cross-platform show mapping

### Database
- **Neon PostgreSQL**: Serverless PostgreSQL database for production
- **Drizzle ORM**: Database toolkit with migrations and type safety

### UI Framework
- **Radix UI**: Headless UI components for accessibility and functionality
- **shadcn/ui**: Pre-built component library built on Radix UI
- **Tailwind CSS**: Utility-first CSS framework for styling

### Development Tools
- **Vite**: Build tool and development server with hot reload
- **TypeScript**: Type safety across the entire application
- **ESBuild**: Fast JavaScript bundler for production builds
- **Replit Integration**: Development environment with runtime error overlay and cartographer plugins

## Automated Scheduling

The application includes two automated daily jobs using node-cron:

### Daily Episode Sync

The application includes an automated daily episode sync that updates episode data for all users. This runs automatically within the main application using node-cron.

#### How It Works

The `server/episode-scheduler.ts` module:
- Uses node-cron to schedule a daily job at 3:00 AM Eastern Time
- Automatically starts when the application launches
- Fetches all users from the database
- For each user, syncs episodes for their active (non-ended) shows
- Fetches latest episode data from TVMaze API
- Adds new episodes with "untriaged" status
- Updates existing episodes with latest metadata
- Logs comprehensive sync results including imported count, skipped count, and any errors

#### Monitoring

- Check server logs for scheduler messages prefixed with `[SCHEDULER]`
- At startup, you'll see: "Episode sync scheduler initialized - will run daily at 3:00 AM Eastern Time"
- During sync, detailed logs show progress for each user and show
- After completion, see summary with total imported/skipped episodes and error count

### Daily Recommendation Refresh

The application also includes an automated daily recommendation refresh that updates personalized show suggestions.

#### How It Works

The `server/recommendation-scheduler.ts` module:
- Uses node-cron to schedule a daily job at 4:00 AM Eastern Time
- Automatically starts when the application launches
- For each user, fetches TMDB recommendations from their library shows
- Maps TVMaze shows to TMDB IDs for cross-platform recommendations
- Aggregates and scores recommendations based on frequency, rating, and genre match
- Filters out dismissed shows and shows already in user's library
- Logs comprehensive results including imported count and errors

#### Monitoring

- Check server logs for scheduler messages prefixed with `[RECOMMENDATION_SCHEDULER]`
- At startup, you'll see: "Recommendation refresh scheduler initialized - will run daily at 4:00 AM Eastern Time"
- During refresh, detailed logs show progress for mapping and scoring
- After completion, see summary with total recommendations imported and error count

### Configuration

Both schedulers can be configured by editing their respective files:

1. Edit `server/episode-scheduler.ts` or `server/recommendation-scheduler.ts`
2. Change the cron expression in the `cron.schedule()` call
3. Optionally change the timezone (default: "America/New_York")

Common cron patterns:
- `0 3 * * *` - Daily at 3:00 AM
- `0 */6 * * *` - Every 6 hours
- `0 0 * * 0` - Weekly on Sunday at midnight

### Technical Details

- **Package**: node-cron for job scheduling
- **Timezone Support**: Both run in Eastern Time zone by default
- **Error Handling**: Continues processing other items if individual items fail
- **Database**: Uses the same database connection as the main application
- **Performance**: Episode sync filters out ended shows; recommendation refresh caches genre mappings