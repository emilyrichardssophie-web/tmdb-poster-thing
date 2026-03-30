require("dotenv").config();
const express = require("express");
const axios = require("axios");
const config = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_BASE = "https://api.themoviedb.org/3";

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

// --- GET IMAGE BASE ---
function getImageBase(type, variant) {
  const size =
    config.imageSize[type]?.[variant] ||
    config.imageSize[type]?.original ||
    "original";

  return `https://image.tmdb.org/t/p/${size}`;
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

  // ❌ Reject very low resolution
  if (width < 700) return -Infinity;

  const normalizedWidth = (width / stats.maxWidth) * 10;

  // ✅ HARD CAP votes (no scaling past 5)
  const voteScore = Math.min(voteCount, 5);

  let wVotes, wRating, wWidth;

  // ✅ After 5 votes → rating dominates
  if (voteCount >= 5) {
    wVotes = 0.1;
    wRating = 0.75;
    wWidth = 0.15;
  } else if (stats.avgVotes >= 5) {
    wVotes = 0.25;
    wRating = 0.55;
    wWidth = 0.2;
  } else {
    wVotes = 0.15;
    wRating = 0.7;
    wWidth = 0.15;
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

  // 🎬 Backdrops → prefer textless
  if (isBackdrop) {
    const textless = images.filter(p => p.iso_639_1 === null);
    if (textless.length) {
      images = textless;
    }
  } else {
    images = filterByLanguage(images);
  }

  const stats = computeStats(images);

  const scored = images.map(img => ({
    ...img,
    _score: computeScore(img, stats)
  }));

  scored.sort((a, b) => b._score - a._score);

  if (!scored.length) return null;

  const original = scored[0];

  const variant = isBackdrop
    ? config.variant.backdrop
    : config.variant.poster;

  if (variant !== "alternative") {
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

    const image = pickImage(posters, false);
    if (!image) return res.status(404).send("No suitable poster");

    const variant = config.variant.poster;
    const base = getImageBase("poster", variant);

    return res.redirect(`${base}${image.file_path}`);

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

// BACKDROP
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

    const variant = config.variant.backdrop;
    const base = getImageBase("backdrop", variant);

    return res.redirect(`${base}${image.file_path}`);

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
