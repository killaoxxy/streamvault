(function () {
  "use strict";

  /** TMDB read token — exposed in browser on static hosting; rotate if abused. */
  const TMDB_READ_TOKEN =
    "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmNjVmNmE5ZGQ4MjZmNjk0ZDViYWY5MzJlOTk4ZGFkNCIsIm5iZiI6MTc3NDc4MjQwOS40NzYsInN1YiI6IjY5YzkwN2M5NjNkYjJmM2JmN2QzNmI4NCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.fgluLBnU2KN8nrogkjn4P4_6USwoZLpg9gwxSmI2K4U";

  const API_BASE = "https://api.themoviedb.org/3";
  const IMG_BASE = "https://image.tmdb.org/t/p/w500";

  const MODE_MOVIE = "movie";
  const MODE_TV = "tv";
  const MODE_ANIME = "anime";

  const GENRE_ANIMATION = 16;
  const ANIME_LANG = "ja";

  const DEBOUNCE_MS = 320;
  const TRENDING_COUNT = 20;

  const discoverAnimeParams = {
    with_genres: String(GENRE_ANIMATION),
    with_original_language: ANIME_LANG,
    sort_by: "popularity.desc",
    page: 1,
  };

  const els = {
    modeMovie: document.getElementById("mode-movie"),
    modeTv: document.getElementById("mode-tv"),
    modeAnime: document.getElementById("mode-anime"),
    liveSearch: document.getElementById("live-search"),
    error: document.getElementById("error-msg"),
    searchSection: document.getElementById("search-results-section"),
    searchGrid: document.getElementById("search-grid"),
    resultsMeta: document.getElementById("results-meta"),
    trendingGrid: document.getElementById("trending-grid"),
    trendingHeading: document.getElementById("trending-heading"),
    trendingMeta: document.getElementById("trending-meta"),
    embedUrl: document.getElementById("embed-url-display"),
    iframe: document.getElementById("player"),
    placeholder: document.getElementById("player-placeholder"),
    playerSection: document.getElementById("player-section"),
    prefSub: document.getElementById("pref-sub"),
    prefDub: document.getElementById("pref-dub"),
    dubToggle: document.getElementById("dub-toggle"),
  };

  const catalog = {
    movie: { items: [], loaded: false },
    tv: { items: [], loaded: false },
    anime: { items: [], loaded: false },
  };

  let mode = MODE_MOVIE;
  let isDub = false;
  /** @type {{ id: number; mediaType: string; isAnime: boolean } | null} */
  let lastMedia = null;

  let searchTimer = 0;
  let searchGeneration = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let vidplusAnimeFallbackTimer = null;
  /** @type {(() => void) | null} */
  let animeMovieLoadHandler = null;

  const DEFAULT_SEASON = 1;
  const DEFAULT_EPISODE = 1;
  const ANIME_MOVIE_FALLBACK_MS = 8000;

  function clearVidplusFallbackTimer() {
    if (vidplusAnimeFallbackTimer !== null) {
      clearTimeout(vidplusAnimeFallbackTimer);
      vidplusAnimeFallbackTimer = null;
    }
  }

  function clearAnimeMovieLoadHandler() {
    if (animeMovieLoadHandler) {
      els.iframe.removeEventListener("load", animeMovieLoadHandler);
      animeMovieLoadHandler = null;
    }
  }

  /**
   * VidPlus expects explicit dub=true | dub=false.
   * @param {boolean} isDub
   */
  function buildVidPlusQueryString(isDub) {
    const p = new URLSearchParams();
    p.set("dub", isDub ? "true" : "false");
    p.set("color", "e11d48");
    return p.toString();
  }

  /**
   * @param {number} id TMDB id
   * @param {number} season
   * @param {number} episode
   * @param {boolean} isDub
   */
  function buildVidPlusTvUrl(id, season, episode, isDub) {
    return (
      "https://player.vidplus.to/embed/tv/" +
      id +
      "/" +
      season +
      "/" +
      episode +
      "?" +
      buildVidPlusQueryString(isDub)
    );
  }

  /**
   * Anime route: /embed/anime/{id}/{episode} (single episode index, not season/episode).
   * @param {number} id TMDB id
   * @param {number} episode
   * @param {boolean} isDub
   */
  function buildVidPlusAnimeUrl(id, episode, isDub) {
    return (
      "https://player.vidplus.to/embed/anime/" +
      id +
      "/" +
      episode +
      "?" +
      buildVidPlusQueryString(isDub)
    );
  }

  function hideError() {
    els.error.hidden = true;
    els.error.textContent = "";
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }

  async function tmdbFetch(path, params) {
    const url = new URL(API_BASE + path);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      });
    }
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: "Bearer " + TMDB_READ_TOKEN,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText || "TMDB request failed (" + res.status + ")");
    }
    return res.json();
  }

  function posterUrl(path) {
    if (!path) return "";
    return IMG_BASE + path;
  }

  function yearFromItem(item, mediaType) {
    const raw = mediaType === "tv" ? item.first_air_date : item.release_date;
    if (!raw || typeof raw !== "string") return "—";
    const y = raw.slice(0, 4);
    return y || "—";
  }

  function titleFromItem(item, mediaType) {
    if (mediaType === "tv") return item.name || "Untitled";
    return item.title || "Untitled";
  }

  /**
   * @param {object} m
   * @param {boolean} [isAnime]
   */
  function normalizeMovie(m, isAnime) {
    return {
      id: m.id,
      media_type: "movie",
      title: titleFromItem(m, "movie"),
      year: yearFromItem(m, "movie"),
      poster_path: m.poster_path || null,
      isAnime: !!isAnime,
    };
  }

  /**
   * @param {object} t
   * @param {boolean} [isAnime]
   */
  function normalizeTv(t, isAnime) {
    return {
      id: t.id,
      media_type: "tv",
      title: titleFromItem(t, "tv"),
      year: yearFromItem(t, "tv"),
      poster_path: t.poster_path || null,
      isAnime: !!isAnime,
    };
  }

  /**
   * @param {object} r
   * @returns {ReturnType<typeof normalizeMovie>|ReturnType<typeof normalizeTv>|null}
   */
  function normalizeMultiResult(r) {
    if (r.media_type === "movie") return normalizeMovie(r, false);
    if (r.media_type === "tv") return normalizeTv(r, false);
    return null;
  }

  /**
   * @param {object} r TMDB multi search hit
   */
  function passesAnimeFilter(r) {
    if (r.media_type !== "movie" && r.media_type !== "tv") return false;
    const ids = r.genre_ids;
    if (!Array.isArray(ids) || ids.indexOf(GENRE_ANIMATION) === -1) return false;
    return r.original_language === ANIME_LANG;
  }

  /**
   * @param {number} id
   * @param {"movie"|"tv"} mediaType
   * @param {{ isAnime?: boolean; isDub: boolean }} opts
   */
  function buildEmbedUrl(id, mediaType, opts) {
    const isAnime = !!opts.isAnime;
    const dub = opts.isDub;

    if (isAnime) {
      if (mediaType === "tv") {
        return buildVidPlusTvUrl(id, DEFAULT_SEASON, DEFAULT_EPISODE, dub);
      }
      return buildVidPlusAnimeUrl(id, DEFAULT_EPISODE, dub);
    }

    if (mediaType === "tv") {
      return (
        "https://www.vidking.net/embed/tv/" +
        id +
        "/1/1?color=e11d48&autoPlay=true&episodeSelector=true"
      );
    }
    return "https://www.vidking.net/embed/movie/" + id + "?color=e11d48&autoPlay=true";
  }

  /**
   * @param {number} id
   * @param {"movie"|"tv"} mediaType
   * @param {{ isAnime?: boolean }} [opts]
   */
  function loadMedia(id, mediaType, opts) {
    opts = opts || {};
    const isAnime = !!opts.isAnime;
    clearVidplusFallbackTimer();
    clearAnimeMovieLoadHandler();

    const dubParam = isAnime ? isDub : false;

    lastMedia = { id: id, mediaType: mediaType, isAnime: isAnime };

    const url = buildEmbedUrl(id, mediaType, { isAnime: isAnime, isDub: dubParam });
    hideError();
    els.embedUrl.textContent = url;

    if (isAnime && mediaType === "movie") {
      const tvFallbackUrl = buildVidPlusTvUrl(
        id,
        DEFAULT_SEASON,
        DEFAULT_EPISODE,
        dubParam
      );
      function onAnimeMovieLoaded() {
        clearVidplusFallbackTimer();
        clearAnimeMovieLoadHandler();
      }
      animeMovieLoadHandler = onAnimeMovieLoaded;
      els.iframe.addEventListener("load", onAnimeMovieLoaded);
      vidplusAnimeFallbackTimer = setTimeout(function () {
        vidplusAnimeFallbackTimer = null;
        clearAnimeMovieLoadHandler();
        if (
          lastMedia &&
          lastMedia.id === id &&
          lastMedia.mediaType === "movie" &&
          lastMedia.isAnime
        ) {
          els.iframe.src = tvFallbackUrl;
          els.embedUrl.textContent = tvFallbackUrl;
        }
      }, ANIME_MOVIE_FALLBACK_MS);
    }

    els.iframe.src = url;
    els.iframe.hidden = false;
    els.placeholder.classList.add("is-hidden");
    els.playerSection.scrollIntoView({ behavior: "smooth", block: "start" });
    requestAnimationFrame(function () {
      els.iframe.focus();
    });
  }

  function setDubPreference(nextDub) {
    isDub = nextDub;
    els.prefSub.classList.toggle("is-active", !isDub);
    els.prefDub.classList.toggle("is-active", isDub);
    els.prefSub.setAttribute("aria-pressed", (!isDub).toString());
    els.prefDub.setAttribute("aria-pressed", isDub.toString());

    if (els.dubToggle) {
      els.dubToggle.classList.toggle("dub-toggle--dub-on", isDub);
    }

    document.querySelectorAll(".media-card-lang").forEach(function (el) {
      el.textContent = isDub ? "Dub" : "Sub";
    });

    if (lastMedia && lastMedia.isAnime) {
      loadMedia(lastMedia.id, lastMedia.mediaType, { isAnime: true });
    }
  }

  function syncTabAria() {
    const tabs = [els.modeMovie, els.modeTv, els.modeAnime];
    tabs.forEach(function (btn) {
      const active = btn.classList.contains("is-active");
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function fillSkeletonGrid(container, count) {
    clearChildren(container);
    for (let i = 0; i < count; i += 1) {
      const sk = document.createElement("div");
      sk.className = "card-skeleton";
      sk.setAttribute("aria-hidden", "true");
      container.appendChild(sk);
    }
  }

  /**
   * @param {HTMLElement} container
   * @param {Array<{ id: number; media_type: string; title: string; year: string; poster_path: string | null; isAnime: boolean }>} items
   */
  function renderMediaCards(container, items) {
    clearChildren(container);
    items.forEach(function (item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "media-card movie-card" + (item.poster_path ? "" : " media-card--empty-poster");
      btn.setAttribute("role", "listitem");
      btn.setAttribute(
        "aria-label",
        "Play " + item.title + " (" + item.year + "), " + item.media_type
      );

      if (item.isAnime) {
        const lang = document.createElement("span");
        lang.className = "media-card-lang movie-chip";
        lang.textContent = isDub ? "Dub" : "Sub";
        btn.appendChild(lang);
      }

      const badge = document.createElement("span");
      badge.className = "media-card-badge";
      badge.textContent =
        item.media_type === "tv" ? (item.isAnime ? "Anime" : "TV") : item.isAnime ? "Anime" : "Movie";
      btn.appendChild(badge);

      if (item.poster_path) {
        const img = document.createElement("img");
        img.src = posterUrl(item.poster_path);
        img.alt = "";
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
        btn.appendChild(img);
      }

      const overlay = document.createElement("div");
      overlay.className = "media-card-overlay";
      btn.appendChild(overlay);

      const meta = document.createElement("div");
      meta.className = "media-card-meta";
      const h = document.createElement("p");
      h.className = "media-card-title";
      h.textContent = item.title;
      const y = document.createElement("p");
      y.className = "media-card-year";
      y.textContent = item.year;
      meta.appendChild(h);
      meta.appendChild(y);
      btn.appendChild(meta);

      btn.addEventListener("click", function () {
        loadMedia(item.id, item.media_type, { isAnime: item.isAnime });
      });

      container.appendChild(btn);
    });
  }

  async function ensureMovieTrending() {
    if (catalog.movie.loaded) {
      renderMediaCards(els.trendingGrid, catalog.movie.items);
      return;
    }
    fillSkeletonGrid(els.trendingGrid, TRENDING_COUNT);
    try {
      const data = await tmdbFetch("/trending/movie/day", { page: 1 });
      const raw = Array.isArray(data.results) ? data.results.slice(0, TRENDING_COUNT) : [];
      catalog.movie.items = raw.map(function (m) {
        return normalizeMovie(m, false);
      });
      catalog.movie.loaded = true;
      renderMediaCards(els.trendingGrid, catalog.movie.items);
    } catch (e) {
      clearChildren(els.trendingGrid);
      showError("Could not load trending movies: " + (e.message || "Unknown error"));
    }
  }

  async function ensureTvTrending() {
    if (catalog.tv.loaded) {
      renderMediaCards(els.trendingGrid, catalog.tv.items);
      return;
    }
    fillSkeletonGrid(els.trendingGrid, TRENDING_COUNT);
    try {
      const data = await tmdbFetch("/trending/tv/day", { page: 1 });
      const raw = Array.isArray(data.results) ? data.results.slice(0, TRENDING_COUNT) : [];
      catalog.tv.items = raw.map(function (t) {
        return normalizeTv(t, false);
      });
      catalog.tv.loaded = true;
      renderMediaCards(els.trendingGrid, catalog.tv.items);
    } catch (e) {
      clearChildren(els.trendingGrid);
      showError("Could not load trending TV: " + (e.message || "Unknown error"));
    }
  }

  async function ensureAnimeCatalog() {
    if (catalog.anime.loaded) {
      renderMediaCards(els.trendingGrid, catalog.anime.items);
      return;
    }
    fillSkeletonGrid(els.trendingGrid, TRENDING_COUNT);
    try {
      const [mov, tv] = await Promise.all([
        tmdbFetch("/discover/movie", discoverAnimeParams),
        tmdbFetch("/discover/tv", discoverAnimeParams),
      ]);

      const merged = [];
      (mov.results || []).forEach(function (m) {
        merged.push({
          n: normalizeMovie(m, true),
          pop: m.popularity || 0,
        });
      });
      (tv.results || []).forEach(function (t) {
        merged.push({
          n: normalizeTv(t, true),
          pop: t.popularity || 0,
        });
      });

      merged.sort(function (a, b) {
        return b.pop - a.pop;
      });

      const seen = new Set();
      const deduped = [];
      for (let i = 0; i < merged.length; i += 1) {
        const x = merged[i];
        const key = x.n.media_type + "-" + x.n.id;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(x.n);
        if (deduped.length >= TRENDING_COUNT) break;
      }

      catalog.anime.items = deduped;
      catalog.anime.loaded = true;
      renderMediaCards(els.trendingGrid, catalog.anime.items);
    } catch (e) {
      clearChildren(els.trendingGrid);
      showError("Could not load anime: " + (e.message || "Unknown error"));
    }
  }

  function updateDiscoverTitles() {
    if (mode === MODE_ANIME) {
      els.trendingHeading.textContent = "Popular anime";
      els.trendingMeta.textContent = "Genre 16 · original language: ja";
    } else if (mode === MODE_TV) {
      els.trendingHeading.textContent = "Trending today";
      els.trendingMeta.textContent = "Top 20 TV";
    } else {
      els.trendingHeading.textContent = "Trending today";
      els.trendingMeta.textContent = "Top 20 movies";
    }
  }

  function refreshDiscoverSection() {
    updateDiscoverTitles();
    hideError();
    if (mode === MODE_ANIME) {
      ensureAnimeCatalog();
    } else if (mode === MODE_TV) {
      ensureTvTrending();
    } else {
      ensureMovieTrending();
    }
  }

  function filterByMode(items) {
    if (mode === MODE_MOVIE) return items.filter(function (x) {
      return x.media_type === "movie";
    });
    if (mode === MODE_TV) return items.filter(function (x) {
      return x.media_type === "tv";
    });
    return items;
  }

  /**
   * @param {object[]} raw TMDB multi results
   */
  function filterSearchRaw(raw) {
    if (mode === MODE_ANIME) {
      return raw.filter(passesAnimeFilter).map(function (r) {
        if (r.media_type === "movie") return normalizeMovie(r, true);
        return normalizeTv(r, true);
      });
    }
    const normalized = raw.map(normalizeMultiResult).filter(Boolean);
    return filterByMode(normalized);
  }

  async function runSearch(query) {
    const q = query.trim();
    const gen = ++searchGeneration;

    if (!q) {
      els.searchSection.hidden = true;
      clearChildren(els.searchGrid);
      els.resultsMeta.textContent = "";
      hideError();
      return;
    }

    els.searchSection.hidden = false;
    fillSkeletonGrid(els.searchGrid, 12);
    hideError();

    try {
      const data = await tmdbFetch("/search/multi", {
        query: q,
        page: 1,
        include_adult: "false",
      });
      if (gen !== searchGeneration) return;

      const raw = Array.isArray(data.results) ? data.results : [];
      const filtered = filterSearchRaw(raw);

      renderMediaCards(els.searchGrid, filtered);
      els.resultsMeta.textContent =
        filtered.length === 0 ? "No matches for this filter" : filtered.length + " titles";
    } catch (e) {
      if (gen !== searchGeneration) return;
      clearChildren(els.searchGrid);
      showError("Search failed: " + (e.message || "Unknown error"));
      els.resultsMeta.textContent = "";
    }
  }

  function scheduleSearch() {
    const q = els.liveSearch.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      runSearch(q);
    }, DEBOUNCE_MS);
  }

  function setMode(next) {
    mode = next;
    els.modeMovie.classList.toggle("is-active", mode === MODE_MOVIE);
    els.modeTv.classList.toggle("is-active", mode === MODE_TV);
    els.modeAnime.classList.toggle("is-active", mode === MODE_ANIME);
    syncTabAria();

    hideError();
    window.clearTimeout(searchTimer);
    if (els.liveSearch.value.trim()) {
      runSearch(els.liveSearch.value);
    } else {
      els.searchSection.hidden = true;
      clearChildren(els.searchGrid);
      els.resultsMeta.textContent = "";
    }

    refreshDiscoverSection();
  }

  function init() {
    els.modeMovie.addEventListener("click", function () {
      setMode(MODE_MOVIE);
    });
    els.modeTv.addEventListener("click", function () {
      setMode(MODE_TV);
    });
    els.modeAnime.addEventListener("click", function () {
      setMode(MODE_ANIME);
    });

    els.liveSearch.addEventListener("input", scheduleSearch);
    els.liveSearch.addEventListener("search", scheduleSearch);

    els.prefSub.addEventListener("click", function () {
      setDubPreference(false);
    });
    els.prefDub.addEventListener("click", function () {
      setDubPreference(true);
    });

    if (els.dubToggle) {
      els.dubToggle.classList.toggle("dub-toggle--dub-on", isDub);
    }

    refreshDiscoverSection();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
