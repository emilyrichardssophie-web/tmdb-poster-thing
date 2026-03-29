require("dotenv").config();
const express = require("express");
const axios = require("axios");
const config = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = `https://image.tmdb.org/t/p/${config.imageSize}`;

// Cache
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

// --- TYPE NORMALIZATION ---
function normalizeType(type) {
  if (!type) return null;

  const t = type.toLowerCase();

  if (t === "movie" || t === "movies") return "movie";
  if (["tv", "series", "show", "tvshow"].includes(t)) return "tv";

  return null;
}

// --- FETCH IMAGES ---
async function getImages(type, id) {
  const normalizedType = normalizeType(type);
  if (!normalizedType) throw new Error(`Invalid type: ${type}`);

  const cacheKey = `${normalizedType}:${id}`;

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.time < CACHE_TTL) {
      return cached.data;
    }
  }

  const endpoint =
    normalizedType === "movie"
      ? `${TMDB_BASE}/movie/${id}/images`
      : `${TMDB_BASE}/tv/${id}/images`;

  const res = await axios.get(endpoint, {
    params: {
      api_key: config.tmdbApiKey
    }
  });

  cache.set(cacheKey, {
    data: res.data,
    time: Date.now()
  });

  return res.data;
}

// --- GLOBAL STATS ---
function computeStats(images) {
  const maxWidth = Math.max(...images.map(i => i.width || 1), 1);
  const avgVotes =
    images.reduce((sum, i) => sum + (i.vote_count || 0), 0) /
    Math.max(images.length, 1);

  return { maxWidth, avgVotes };
}

// --- SCORE FUNCTION ---
function computeScore(image, stats) {
  const voteCount = image.vote_count || 0;
  const voteAvg = image.vote_average || 0;
  const width = image.width || 1;

  // Normalize width to 0–10
  const normalizedWidth = (width / stats.maxWidth) * 10;

  // Log scaling for votes
  const voteScore = Math.min(10, Math.log10(voteCount + 1) * 5);

  let wVotes, wRating, wWidth;

  // 🔥 NEW: hard shift after ~8 votes
  if (stats.avgVotes >= 8) {
    // votes matter LESS now
    wVotes = 0.2;
    wRating = 0.5;
    wWidth = 0.3;
  } else if (stats.avgVotes >= 3) {
    wVotes = 0.3;
    wRating = 0.45;
    wWidth = 0.25;
  } else {
    wVotes = 0.1;
    wRating = 0.55;
    wWidth = 0.35;
  }

  return (
    voteScore * wVotes +
    voteAvg * wRating +
    normalizedWidth * wWidth
  );
}

// --- LOW DATA OVERRIDE ---
function tryLowDataOverride(images) {
  if (!images.length) return null;

  const lowVoteCount = images.filter(i => (i.vote_count || 0) <= 3).length;
  const ratio = lowVoteCount / images.length;

  if (ratio < 0.7) return null;

  const bestRated = [...images].sort(
    (a, b) => (b.vote_average || 0) - (a.vote_average || 0)
  )[0];

  const bestWidth = [...images].sort(
    (a, b) => (b.width || 0) - (a.width || 0)
  )[0];

  const avgRating =
    images.reduce((sum, i) => sum + (i.vote_average || 0), 0) /
    Math.max(images.length, 1);

  const avgWidth =
    images.reduce((sum, i) => sum + (i.width || 0), 0) /
    Math.max(images.length, 1);

  const ratingDominant = (bestRated.vote_average || 0) >= avgRating * 1.8;
  const widthDominant = (bestWidth.width || 0) >= avgWidth * 1.5;

  if (ratingDominant) return bestRated;
  if (widthDominant) return bestWidth;

  return null;
}

// --- LANGUAGE FILTER ---
function filterByLanguage(images) {
  let filtered = images.filter(
    p => p.iso_639_1 === config.defaultLanguage
  );

  if (!filtered.length) {
    filtered = images.filter(p => p.iso_639_1 === null);
  }

  if (!filtered.length) {
    filtered = images;
  }

  return filtered;
}

// --- PICK IMAGE ---
function pickImage(images, isBackdrop = false) {
  if (!images.length) return null;

  // BACKDROPS → prefer textless
  if (isBackdrop) {
    const textless = images.filter(p => p.iso_639_1 === null);
    if (textless.length) images = textless;
  } else {
    images = filterByLanguage(images);
  }

  const stats = computeStats(images);

  // 🧠 LOW DATA OVERRIDE
  const override = tryLowDataOverride(images);
  if (override) return override;

  // Score images
  const scored = images.map(img => ({
    ...img,
    _score: computeScore(img, stats)
  }));

  scored.sort((a, b) => b._score - a._score);

  if (!scored.length) return null;

  const original = scored[0];

  if (config.variant !== "alternative") {
    return original;
  }

  const alternatives = scored.slice(1);

  if (!alternatives.length) return original;

  const strongAlternatives = alternatives.filter(alt => {
    const scoreRatio = alt._score / original._score;
    const hasVotes = alt.vote_count >= 2;

    return scoreRatio >= 0.75 && hasVotes;
  });

  if (strongAlternatives.length) {
    return strongAlternatives[0];
  }

  const second = alternatives[0];
  if (second && second._score >= original._score * 0.85) {
    return second;
  }

  return original;
}

// --- ROUTES ---

app.get("/poster/tmdb:raw", async (req, res) => {
  try {
    const raw = req.params.raw.replace(/^:/, "");
    const [type, id] = raw.split(":");

    if (!type || !id) {
      return res.status(400).send("Invalid format");
    }

    const data = await getImages(type, id);
    const posters = data.posters || [];

    if (!posters.length) {
      return res.status(404).send("No posters found");
    }

    const image = pickImage(posters);
    if (!image) return res.status(404).send("No suitable poster");

    return res.redirect(`${IMAGE_BASE}${image.file_path}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

app.get("/background/tmdb:raw", async (req, res) => {
  try {
    const raw = req.params.raw.replace(/^:/, "");
    const [type, id] = raw.split(":");

    if (!type || !id) {
      return res.status(400).send("Invalid format");
    }

    const data = await getImages(type, id);
    const backdrops = data.backdrops || [];

    if (!backdrops.length) {
      return res.status(404).send("No backdrops found");
    }

    const image = pickImage(backdrops, true);
    if (!image) return res.status(404).send("No suitable backdrop");

    return res.redirect(`${IMAGE_BASE}${image.file_path}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
