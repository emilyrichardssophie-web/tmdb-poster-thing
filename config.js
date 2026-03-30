require("dotenv").config();

function get(key, fallback) {
  return process.env[key] || fallback;
}

const config = {
  tmdbApiKey: process.env.TMDB_API_KEY,

  defaultLanguage: get("DEFAULT_LANGUAGE", "en"),

  // ✅ Variant per type
  variant: {
    poster: get("POSTER_VARIANT", "original"),
    backdrop: get("BACKDROP_VARIANT", "original")
  },

  // ✅ Size per type + variant
  imageSize: {
    poster: {
      original: get("POSTER_SIZE_ORIGINAL", "w500"),
      alternative: get("POSTER_SIZE_ALTERNATIVE", "w500")
    },
    backdrop: {
      original: get("BACKDROP_SIZE_ORIGINAL", "original"),
      alternative: get("BACKDROP_SIZE_ALTERNATIVE", "original")
    }
  }
};

module.exports = config;
