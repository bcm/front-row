// Agent-friendly projections of domain rows: small, stable, no raw jsonb blobs.

import type { Show, Episode, UserShow } from "@shared/schema";

export interface ShowSummary {
  tvmaze_id: number;
  name: string;
  status: string | null;
  premiered: string | null;
  network: string | null;
  genres: string[] | null;
  rating: number | null;
}

export function trimShow(show: Show): ShowSummary {
  return {
    tvmaze_id: show.id,
    name: show.name,
    status: show.status,
    premiered: show.premiered,
    network: show.network?.name ?? show.webChannel?.name ?? null,
    genres: show.genres,
    rating: show.rating?.average ?? null,
  };
}

export interface LibraryEntry extends ShowSummary {
  added_at: string | null;
  is_shared: boolean;
  group_id: string | null;
}

export function trimLibraryEntry(us: UserShow & { show: Show }): LibraryEntry {
  return {
    ...trimShow(us.show),
    added_at: us.addedAt?.toISOString() ?? null,
    is_shared: us.groupId != null,
    group_id: us.groupId,
  };
}

export interface EpisodeSummary {
  tvmaze_id: number;
  season: number | null;
  number: number | null;
  name: string | null;
  airdate: string | null;
  runtime: number | null;
}

export function trimEpisode(ep: Episode): EpisodeSummary {
  return {
    tvmaze_id: ep.id,
    season: ep.season,
    number: ep.number,
    name: ep.name,
    airdate: ep.airdate,
    runtime: ep.runtime,
  };
}
