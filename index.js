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

// --- FETCH POSTERS ---
async function getPosters(type, id) {
  const normalizedType = normalizeType(type);

  if (!normalizedType) {
    throw new Error(`Invalid type: ${type}`);
  }

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
      api_key: config.tmdbApiKey,
      include_image_language: `${config.defaultLanguage},null`
    }
  });

  const posters = res.data.posters || [];

  cache.set(cacheKey, {
    data: posters,
    time: Date.now()
  });

  return posters;
}

// --- SORTING LOGIC ---
function sortPosters(posters) {
  return posters.sort((a, b) => {
    // 1. More votes = more "official"
    if (b.vote_count !== a.vote_count) {
      return b.vote_count - a.vote_count;
    }

    // 2. Higher rating
    if (b.vote_average !== a.vote_average) {
      return b.vote_average - a.vote_average;
    }

    // 3. Higher resolution
    return b.width - a.width;
  });
}

// --- PICK POSTER ---
function pickPoster(posters) {
  if (!posters.length) return null;

  // 1. Exact language
  let filtered = posters.filter(
    p => p.iso_639_1 === config.defaultLanguage
  );

  // 2. Fallback to "no language"
  if (!filtered.length) {
    filtered = posters.filter(p => p.iso_639_1 === null);
  }

  // 3. Fallback to ANY language
  if (!filtered.length && config.fallbackToAnyLanguage) {
    filtered = posters;
  }

  if (!filtered.length) return null;

  const sorted = sortPosters(filtered);

  // ORIGINAL
  if (config.variant !== "alternative") {
    return sorted[0];
  }

  // ALTERNATIVE (avoid near-duplicates)
  const original = sorted[0];

  const alternative = sorted.find(p =>
    p.file_path !== original.file_path &&
    Math.abs(p.width - original.width) > 50
  );

  return alternative || sorted[1] || sorted[0];
}

// --- ROUTE ---
app.get("/tmdb:raw", async (req, res) => {
  try {
    const raw = req.params.raw.replace(/^:/, "");
    const [type, id] = raw.split(":");

    if (!type || !id) {
      return res.status(400).send("Invalid format");
    }

    const posters = await getPosters(type, id);

    if (!posters.length) {
      return res.status(404).send("No posters found");
    }

    const poster = pickPoster(posters);

    if (!poster) {
      return res.status(404).send("No suitable poster");
    }

    const imageUrl = `${IMAGE_BASE}${poster.file_path}`;

    return res.redirect(imageUrl);

  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
