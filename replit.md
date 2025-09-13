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
- **UserShows**: Many-to-many relationship tracking user's show collections with status, priority, and progress
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

### September 13, 2025
- **Episode Detail Page**: Added comprehensive episode detail page (`/episode/:id`) with full episode information, show context, and status management
- **Episode Linking**: All episode names throughout the application now link to their respective episode detail pages
- **Scrobble API Integration**: Enhanced show sync process to automatically apply user's personal watch status from TVMaze scrobble API
- **Status Management**: Complete episode status cycling functionality (UNWATCHED → NEXT → LATER → WATCHED → UNWATCHED) across all pages
- **Navigation Enhancement**: Improved navigation flows between dashboard, show details, and episode details

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