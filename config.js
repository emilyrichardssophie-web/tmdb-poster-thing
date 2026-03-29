module.exports = {
  tmdbApiKey: process.env.TMDB_API_KEY,

  defaultLanguage: process.env.DEFAULT_LANGUAGE || "en",

  variant: process.env.VARIANT || "original",

  fallbackToAnyLanguage: process.env.FALLBACK === "true",

  imageSize: process.env.IMAGE_SIZE || "original"
};
