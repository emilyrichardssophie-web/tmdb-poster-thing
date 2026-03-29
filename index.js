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

// --- STATS ---
function computeStats(images) {
  const maxWidth = Math.max(...images.map(i => i.width || 0), 1);

  const avgVotes =
    images.reduce((sum, i) => sum + i.vote_count, 0) /
    Math.max(images.length, 1);

  return {
    maxWidth,
    avgVotes,
    voteThreshold: 10
  };
}

// --- SCORING ---
function computeScore(image, stats) {
  const { vote_count, vote_average, width, aspect_ratio } = image;

  const normalizedWidth = width / stats.maxWidth;

  const confidence = Math.min(1, vote_count / stats.voteThreshold);
  const adjustedRating = vote_average * confidence;

  const voteScore = Math.log(vote_count + 1);

  let wRating, wVotes, wWidth;

  if (stats.avgVotes < 3) {
    wRating = 0.3;
    wVotes = 0.2;
    wWidth = 0.5;
  } else if (stats.avgVotes < 10) {
    wRating = 0.5;
    wVotes = 0.3;
    wWidth = 0.2;
  } else {
    wRating = 0.6;
    wVotes = 0.3;
    wWidth = 0.1;
  }

  // slight bonus for ideal backdrop ratio
  let aspectBonus = 0;
  if (aspect_ratio && Math.abs(aspect_ratio - 1.778) < 0.01) {
    aspectBonus = 0.05;
  }

  return (
    adjustedRating * wRating +
    voteScore * wVotes +
    normalizedWidth * wWidth +
    aspectBonus
  );
}

// --- SORT ---
function sortImages(images) {
  const stats = computeStats(images);

  return images
    .map(img => ({
      ...img,
      _score: computeScore(img, stats)
    }))
    .sort((a, b) => b._score - a._score);
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

// --- PICK IMAGE ---
function pickImage(images, isBackdrop = false) {
  if (!images.length) return null;

  // remove tiny images
  images = images.filter(p => p.width >= 1000);
  if (!images.length) return null;

  // 🎬 BACKDROP: prefer textless first
  if (isBackdrop) {
    const textless = images.filter(p => p.iso_639_1 === null);
    if (textless.length) {
      images = textless;
    }
  }

  // 1. language
  let filtered = filterByLanguage(images);

  // 2. votes
  filtered = applyVoteFilter(filtered);

  // 3. sort (smart scoring)
  const sorted = sortImages(filtered);

  if (!sorted.length) return null;

  // ORIGINAL
  if (config.variant !== "alternative") {
    return sorted[0];
  }

  // ALTERNATIVE
  const original = sorted[0];

  const alternatives = sorted.slice(1).filter(p => {
    if (p.file_path === original.file_path) return false;

    const voteOk = p.vote_count >= Math.max(2, original.vote_count * 0.3);
    const ratingOk = p.vote_average >= original.vote_average * 0.7;
    const widthOk = p.width >= original.width * 0.7;

    return voteOk && (ratingOk || widthOk);
  });

  const alt = alternatives[0];

  // fallback if alternative is weak
  if (!alt || alt._score < original._score * 0.75) {
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
