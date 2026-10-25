import { buildYouTubeChannelUrl, buildYouTubeWatchUrl } from "./video-actions.mjs?v=20260821-gemini-brief";
import { ARCHIVE_RETENTION_DAYS } from "./daily-archive.mjs?v=20260821-gemini-brief";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;
const VIDEO_ID_PATTERN = /^[\w-]{11}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAILS_BATCH_SIZE = 50;
const CHANNEL_CONCURRENCY = 4;
export const DEFAULT_PER_TYPE = 15;

export class ApiKeyError extends Error {}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^﻿/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

export function parseSubscriptionsCsv(text) {
  const seen = new Set();
  const subscriptions = [];
  for (const [rawId = "", , rawTitle = ""] of parseCsvRows(text)) {
    const channelId = rawId.trim();
    if (!CHANNEL_ID_PATTERN.test(channelId) || seen.has(channelId)) continue;
    seen.add(channelId);
    subscriptions.push({ channelId, title: rawTitle.trim() || channelId });
  }
  return subscriptions;
}

function playlistIdFor(channelId, type) {
  return `${type === "short" ? "UUSH" : "UULF"}${channelId.slice(2)}`;
}

async function apiGet(fetchImpl, path, params) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url.toString());
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body;
  const message = body?.error?.message || `HTTP ${response.status}`;
  const reasons = (body?.error?.errors || []).map((error) => error.reason);
  const keyProblem = response.status === 400 && reasons.includes("badRequest") && /API key/i.test(message);
  if (response.status === 403 || keyProblem) throw new ApiKeyError(message);
  const error = new Error(message);
  error.status = response.status;
  throw error;
}

export async function fetchChannelVideos({ apiKey, channelId, perType = DEFAULT_PER_TYPE, fetchImpl = fetch }) {
  const entries = [];
  for (const type of ["long", "short"]) {
    try {
      const body = await apiGet(fetchImpl, "playlistItems", {
        part: "contentDetails",
        maxResults: perType,
        playlistId: playlistIdFor(channelId, type),
        key: apiKey,
      });
      for (const item of body.items || []) {
        const id = item?.contentDetails?.videoId;
        if (VIDEO_ID_PATTERN.test(id || "")) entries.push({ id, type, channelId });
      }
    } catch (error) {
      // A channel without Shorts (or without long uploads) has no UUSH/UULF playlist and answers 404.
      if (error.status !== 404) throw error;
    }
  }
  return entries;
}

export async function fetchVideoDetails({ apiKey, ids, fetchImpl = fetch }) {
  const details = new Map();
  for (let start = 0; start < ids.length; start += DETAILS_BATCH_SIZE) {
    const body = await apiGet(fetchImpl, "videos", {
      part: "snippet,contentDetails,statistics,status",
      id: ids.slice(start, start + DETAILS_BATCH_SIZE).join(","),
      maxResults: DETAILS_BATCH_SIZE,
      key: apiKey,
    });
    for (const video of body.items || []) details.set(video.id, video);
  }
  return details;
}

export function parseIsoDuration(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || ""));
  if (!match) return null;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function durationLabel(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function viewsLabel(count) {
  if (!Number.isFinite(count)) return "";
  const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
  return `${compact} view${count === 1 ? "" : "s"}`;
}

function bestThumbnail(thumbnails = {}, id) {
  const url = thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || "";
  return url.startsWith("https://i.ytimg.com/") ? url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function feedItemFromApi({ entry, video, channelTitle }) {
  const snippet = video?.snippet || {};
  if (snippet.liveBroadcastContent && snippet.liveBroadcastContent !== "none") return null;
  const durationSeconds = parseIsoDuration(video?.contentDetails?.duration);
  const viewCount = Number(video?.statistics?.viewCount);
  const publishedAt = snippet.publishedAt || "";
  return {
    id: entry.id,
    type: entry.type,
    title: snippet.title || "",
    channel: snippet.channelTitle || channelTitle || "",
    channelId: entry.channelId,
    handle: "",
    channelUrl: buildYouTubeChannelUrl({ channelId: entry.channelId }),
    category: "Subscriptions",
    thumbnail: bestThumbnail(snippet.thumbnails, entry.id),
    duration: durationLabel(durationSeconds) || (entry.type === "short" ? "Short" : ""),
    durationSeconds,
    views: viewsLabel(viewCount),
    viewCount: Number.isFinite(viewCount) ? viewCount : null,
    publishedAt,
    publishedLabel: "",
    firstSeenAt: publishedAt,
    source: "primary",
    priority: 1,
    url: buildYouTubeWatchUrl(entry.id),
    embedAllowed: video?.status?.embeddable !== false,
  };
}

export function buildLocalFeed({ subscriptions, previousItems = [], freshItems = [], failures = [], now = new Date(), timeZone = "" }) {
  const subscribed = new Set(subscriptions.map((subscription) => subscription.channelId));
  const oldestAllowed = now.getTime() - ARCHIVE_RETENTION_DAYS * DAY_MS;
  const previousIds = new Set(previousItems.map((item) => item.id));
  const byId = new Map();
  for (const item of [...previousItems, ...freshItems]) {
    if (!subscribed.has(item.channelId)) continue;
    const published = new Date(item.publishedAt).getTime();
    if (!Number.isFinite(published) || published < oldestAllowed) continue;
    byId.set(item.id, item);
  }
  const items = [...byId.values()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const shorts = items.filter((item) => item.type === "short").length;
  return {
    schemaVersion: 4,
    source: "local",
    updatedAt: now.toISOString(),
    siteName: "YourTube",
    archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
    archiveTimezone: timeZone,
    stats: {
      total: items.length,
      longVideos: items.length - shorts,
      shorts,
      primary: items.length,
      secondary: 0,
      newThisRun: freshItems.filter((item) => !previousIds.has(item.id)).length,
    },
    health: {
      channelsRequested: subscriptions.length,
      channelsChecked: subscriptions.length - failures.length,
      channelsWithWarnings: failures.length,
      failures,
    },
    items,
  };
}

async function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  async function run() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

export async function refreshLocalFeed({
  apiKey,
  subscriptions,
  previousItems = [],
  perType = DEFAULT_PER_TYPE,
  fetchImpl = fetch,
  now = () => new Date(),
  timeZone = "",
  onProgress = () => {},
}) {
  if (!apiKey) throw new ApiKeyError("API key is missing.");
  const failures = [];
  let done = 0;
  const perChannel = await mapWithConcurrency(subscriptions, CHANNEL_CONCURRENCY, async (subscription) => {
    try {
      return await fetchChannelVideos({ apiKey, channelId: subscription.channelId, perType, fetchImpl });
    } catch (error) {
      if (error instanceof ApiKeyError) throw error;
      failures.push({ channelId: subscription.channelId, channel: subscription.title, message: error.message });
      return [];
    } finally {
      done += 1;
      onProgress({ done, total: subscriptions.length });
    }
  });
  const entries = perChannel.flat();
  const details = await fetchVideoDetails({ apiKey, ids: entries.map((entry) => entry.id), fetchImpl });
  const titles = new Map(subscriptions.map((subscription) => [subscription.channelId, subscription.title]));
  const freshItems = entries
    .map((entry) => (details.has(entry.id)
      ? feedItemFromApi({ entry, video: details.get(entry.id), channelTitle: titles.get(entry.channelId) })
      : null))
    .filter(Boolean);
  return buildLocalFeed({ subscriptions, previousItems, freshItems, failures, now: now(), timeZone });
}
