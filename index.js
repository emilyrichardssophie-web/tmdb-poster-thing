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

// --- SAFE VOTE FILTER ---
function applyVoteFilter(images) {
  const viable = images.filter(p => p.vote_count >= 2);
  return viable.length ? viable : images;
}

// --- COMPUTE STATS ---
function computeStats(images) {
  const maxWidth = Math.max(...images.map(p => p.width || 1));
  const avgVotes =
    images.reduce((sum, p) => sum + p.vote_count, 0) / images.length;

  return { maxWidth, avgVotes };
}

// --- SCORE SYSTEM ---
function computeScore(p, stats) {
  const vote_count = p.vote_count || 0;
  const vote_average = p.vote_average || 0;
  const width = p.width || 1;

  // --- NORMALIZATION ---
  const normalizedWidth = (width / stats.maxWidth) * 10;

  // 🔥 KEY CHANGE: cap vote influence at 8
  const cappedVotes = Math.min(vote_count, 8);
  const voteScore = Math.log(cappedVotes + 1);

  // --- DYNAMIC WEIGHTS ---
  let wRating, wVotes, wWidth;

  if (vote_count >= 8) {
    // 🔥 once "trusted", prioritize quality heavily
    wRating = 0.7;
    wVotes = 0.1;
    wWidth = 0.2;
  } else if (stats.avgVotes >= 5) {
    wRating = 0.6;
    wVotes = 0.25;
    wWidth = 0.15;
  } else {
    wRating = 0.5;
    wVotes = 0.2;
    wWidth = 0.3;
  }

  return (
    vote_average * wRating +
    voteScore * wVotes +
    normalizedWidth * wWidth
  );
}

// --- PICK IMAGE ---
function pickImage(images, isBackdrop = false) {
  if (!images.length) return null;

  // 🎬 BACKDROP: prefer textless
  if (isBackdrop) {
    const textless = images.filter(p => p.iso_639_1 === null);
    if (textless.length) {
      images = textless;
    }
  } else {
    images = filterByLanguage(images);
  }

  images = applyVoteFilter(images);

  if (!images.length) return null;

  const stats = computeStats(images);

  // score all
  const scored = images.map(p => ({
    ...p,
    _score: computeScore(p, stats)
  }));

  // sort
  scored.sort((a, b) => b._score - a._score);

  const original = scored[0];

  // ORIGINAL
  if (config.variant !== "alternative") {
    return original;
  }

  // ALTERNATIVE
  const alternatives = scored.slice(1).filter(p =>
    p.file_path !== original.file_path &&
    p.vote_count >= Math.max(2, original.vote_count * 0.3)
  );

  if (!alternatives.length) {
    return scored[1] || original;
  }

  const alt = alternatives[0];

  // safety fallback
  if (alt._score < original._score * 0.75) {
    return original;
  }

  return alt;
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
