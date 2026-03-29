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
      // 🚫 NO include_image_language
    }
  });

  cache.set(cacheKey, {
    data: res.data,
    time: Date.now()
  });

  return res.data;
}

// --- SORT ---
function sortImages(images) {
  return images.sort((a, b) => {
    if (b.vote_count !== a.vote_count) {
      return b.vote_count - a.vote_count;
    }

    if (b.vote_average !== a.vote_average) {
      return b.vote_average - a.vote_average;
    }

    return b.width - a.width;
  });
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
    // fallback to ANY language
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

  // 3. sort
  const sorted = sortImages(filtered);

  if (!sorted.length) return null;

  // ORIGINAL
  if (config.variant !== "alternative") {
    return sorted[0];
  }

  // ALTERNATIVE
  const original = sorted[0];

  const alternatives = sorted.slice(1).filter(p =>
    p.file_path !== original.file_path &&
    p.vote_count >= Math.max(2, original.vote_count * 0.3)
  );

  return alternatives[0] || sorted[1] || sorted[0];
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
