require("dotenv").config();
const express = require("express");
const axios = require("axios");
const config = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = `https://image.tmdb.org/t/p/${config.imageSize}`;

// Simple memory cache
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

function getCacheKey(type, id) {
  return `${type}:${id}`;
}

async function getPosters(type, id) {
  const cacheKey = getCacheKey(type, id);

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.time < CACHE_TTL) {
      return cached.data;
    }
  }

  let endpoint;
  if (type === "movie") {
    endpoint = `${TMDB_BASE}/movie/${id}/images`;
  } else if (type === "tv") {
    endpoint = `${TMDB_BASE}/tv/${id}/images`;
  } else {
    throw new Error("Invalid type");
  }

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

function pickPoster(posters) {
  let filtered = posters.filter(
    p => p.iso_639_1 === config.defaultLanguage
  );

  if (!filtered.length && config.fallbackToAnyLanguage) {
    filtered = posters;
  }

  if (!filtered.length) return null;

  // Rank by quality
  filtered.sort((a, b) => {
    const scoreA = a.vote_average * a.vote_count;
    const scoreB = b.vote_average * b.vote_count;
    return scoreB - scoreA;
  });

  if (config.variant === "alternative") {
    return filtered[1] || filtered[0];
  }

  return filtered[0];
}

// Route: /tmdb:movie:550
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
