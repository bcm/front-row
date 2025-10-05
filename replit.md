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
The application uses four main entities:
- **Users**: Authentication and user management
- **Shows**: TV show metadata from TVMaze API
- **UserShows**: Many-to-many relationship tracking user's show collections with status and timestamps (simplified from previous version)
- **Episodes**: Episode information linked to shows for tracking purposes

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

## Recent Changes

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

## Scheduled Deployments

### Daily Episode Sync

The application includes an automated daily episode sync that updates episode data for all users. This runs independently from the main web application using Replit's Scheduled Deployments feature.

#### How It Works

The `scripts/daily-episode-sync.ts` script:
- Connects to the production database using the same `DATABASE_URL` environment variable
- Fetches all users from the database
- For each user, syncs episodes for their active (non-ended) shows
- Fetches latest episode data from TVMaze API
- Adds new episodes with "untriaged" status
- Updates existing episodes with latest metadata
- Logs comprehensive sync results including imported count, skipped count, and any errors

#### Setup Instructions

1. **Open Publishing Tool**: In your Replit workspace, go to the Publishing tool
2. **Create Scheduled Deployment**: Select "Scheduled" option and click "Set up your published app"
3. **Configure Schedule**:
   - **Schedule Description**: "Every day at 3 AM" (or use cron: `0 3 * * *`)
   - **Job Timeout**: 30 minutes (to handle multiple users and many shows)
4. **Set Commands**:
   - **Build Command**: (leave empty, no build needed for script)
   - **Run Command**: `tsx scripts/daily-episode-sync.ts`
5. **Add Secrets**: The script uses the same secrets as your main deployment:
   - `DATABASE_URL` - Your PostgreSQL connection string
   - `TVMAZE_API_KEY` - Your TVMaze API key (if using authenticated endpoints)
   - `TVMAZE_USERNAME` - Your TVMaze username (if using authenticated endpoints)

#### Monitoring

- View sync logs in the Publishing tool's Schedule tab
- Check run history to see success/failure status
- Review detailed logs for each sync run to see:
  - Number of users synced
  - Episodes imported and skipped per user
  - Any errors encountered during the sync

#### Manual Execution

You can also run the sync script manually in development:

```bash
tsx scripts/daily-episode-sync.ts
```

This is useful for testing or running an ad-hoc sync outside the scheduled time.

#### Cost Considerations

- Scheduled Deployments charge based on compute units used
- Replit Core members receive monthly credits that can offset these costs
- The sync script runs once per day and typically completes in a few minutes
- Cost scales with number of users and shows being synced