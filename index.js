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

  // Normalize everything to ~0–10 scale
  const normalizedWidth = (width / stats.maxWidth) * 10;

  // Log scaling for votes (keeps within range)
  const voteScore = Math.min(10, Math.log10(voteCount + 1) * 5);

  // Adaptive weighting
  let wVotes, wRating, wWidth;

  if (stats.avgVotes >= 20) {
    // Popular → trust votes more
    wVotes = 0.5;
    wRating = 0.3;
    wWidth = 0.2;
  } else if (stats.avgVotes >= 5) {
    // Medium confidence
    wVotes = 0.35;
    wRating = 0.4;
    wWidth = 0.25;
  } else {
    // Low data → trust quality more
    wVotes = 0.15;
    wRating = 0.55;
    wWidth = 0.3;
  }

  return (
    voteScore * wVotes +
    voteAvg * wRating +
    normalizedWidth * wWidth
  );
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

  // 🎬 BACKDROP: prefer textless and skip language filtering
  if (isBackdrop) {
    const textless = images.filter(p => p.iso_639_1 === null);
    if (textless.length) {
      images = textless;
    }
  } else {
    images = filterByLanguage(images);
  }

  const stats = computeStats(images);

  // Score all images
  const scored = images.map(img => ({
    ...img,
    _score: computeScore(img, stats)
  }));

  // Sort by score
  scored.sort((a, b) => b._score - a._score);

  if (!scored.length) return null;

  const original = scored[0];

  // ORIGINAL MODE
  if (config.variant !== "alternative") {
    return original;
  }

  // --- ALTERNATIVE MODE ---

  const alternatives = scored.slice(1);

  if (!alternatives.length) return original;

  // Filter out weak alternatives
  const strongAlternatives = alternatives.filter(alt => {
    const scoreRatio = alt._score / original._score;
    const hasVotes = alt.vote_count >= 2;

    return scoreRatio >= 0.75 && hasVotes;
  });

  // Prefer strong alternatives
  if (strongAlternatives.length) {
    return strongAlternatives[0];
  }

  // Fallback: if second best is close enough, use it
  const second = alternatives[0];
  if (second && second._score >= original._score * 0.85) {
    return second;
  }

  // Final fallback
  return original;
}

// --- ROUTES ---

// POSTER
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

// BACKGROUND
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
