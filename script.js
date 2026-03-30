(function () {
  "use strict";

  /** TMDB read token — exposed in browser on static hosting; rotate if abused. */
  const TMDB_READ_TOKEN =
    "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmNjVmNmE5ZGQ4MjZmNjk0ZDViYWY5MzJlOTk4ZGFkNCIsIm5iZiI6MTc3NDc4MjQwOS40NzYsInN1YiI6IjY5YzkwN2M5NjNkYjJmM2JmN2QzNmI4NCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.fgluLBnU2KN8nrogkjn4P4_6USwoZLpg9gwxSmI2K4U";

  const API_BASE = "https://api.themoviedb.org/3";
  const IMG_BASE = "https://image.tmdb.org/t/p/w500";
  const IMG_BACKDROP = "https://image.tmdb.org/t/p/w1280";

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
    netflixGrid: document.getElementById("netflix-grid"),
    top10Grid: document.getElementById("top10-grid"),
    top10Meta: document.getElementById("top10-meta"),
    featuredBackdrop: document.getElementById("featured-backdrop"),
    featuredTitle: document.getElementById("featured-title"),
    featuredMeta: document.getElementById("featured-meta"),
    featuredOverview: document.getElementById("featured-overview"),
    featuredPlay: document.getElementById("featured-play"),
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
    netflix: { items: [], loaded: false },
  };

  /** @type {ReturnType<typeof normalizeMovie>|ReturnType<typeof normalizeTv>|null} */
  let featuredItem = null;

  let mode = MODE_MOVIE;
  let isDub = false;
  /** @type {{ id: number; mediaType: string; isAnime: boolean } | null} */
  let lastMedia = null;

  let searchTimer = 0;
  let searchGeneration = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let heroRotationTimer = null;
  const HERO_SWAP_MS = 30000;

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

  function backdropUrl(path) {
    if (!path) return "";
    return IMG_BACKDROP + path;
  }

  function clipText(str, max) {
    if (!str) return "";
    const t = String(str).trim();
    if (t.length <= max) return t;
    return t.slice(0, max).trim() + "…";
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
      backdrop_path: m.backdrop_path || null,
      overview: typeof m.overview === "string" ? m.overview : "",
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
      backdrop_path: t.backdrop_path || null,
      overview: typeof t.overview === "string" ? t.overview : "",
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

  function fillSkeletonRow(container, count) {
    clearChildren(container);
    for (let i = 0; i < count; i += 1) {
      const sk = document.createElement("div");
      sk.className = "card-skeleton";
      sk.setAttribute("aria-hidden", "true");
      container.appendChild(sk);
    }
  }

  function fillSkeletonTop10(container) {
    clearChildren(container);
    for (let i = 0; i < 10; i += 1) {
      const sk = document.createElement("div");
      sk.className = "top10-skeleton";
      sk.setAttribute("aria-hidden", "true");
      container.appendChild(sk);
    }
  }

  function buildFeaturedMetaLine(item) {
    const bits = [];
    if (item.year && item.year !== "—") bits.push(item.year);
    if (item.isAnime) bits.push("Anime");
    else if (item.media_type === "tv") bits.push("Series");
    else bits.push("Movie");
    return bits.join(" · ");
  }

  function updateFeaturedHero(item) {
    featuredItem = item && item.id ? item : null;
    if (!els.featuredBackdrop || !els.featuredTitle) return;

    if (!featuredItem) {
      els.featuredTitle.textContent = "Featured";
      els.featuredMeta.textContent = "";
      if (els.featuredOverview) {
        els.featuredOverview.textContent = "";
        els.featuredOverview.hidden = true;
      }
      els.featuredBackdrop.hidden = true;
      els.featuredBackdrop.removeAttribute("src");
      if (els.featuredPlay) els.featuredPlay.disabled = true;
      return;
    }

    if (els.featuredPlay) els.featuredPlay.disabled = false;

    els.featuredTitle.textContent = featuredItem.title || "Featured";
    els.featuredMeta.textContent = buildFeaturedMetaLine(featuredItem);
    if (els.featuredOverview) {
      const ov = clipText(featuredItem.overview, 280);
      els.featuredOverview.textContent = ov;
      els.featuredOverview.hidden = !ov;
    }

    const path = featuredItem.backdrop_path || featuredItem.poster_path;
    if (path) {
      els.featuredBackdrop.src = path.indexOf("http") === 0 ? path : backdropUrl(path);
      els.featuredBackdrop.hidden = false;
    } else {
      els.featuredBackdrop.hidden = true;
      els.featuredBackdrop.removeAttribute("src");
    }
  }

  function renderTop10(container, items) {
    if (!container) return;
    clearChildren(container);
    const list = (items || []).slice(0, 10);
    list.forEach(function (item, index) {
      const rank = index + 1;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "top10-card movie-card";
      btn.setAttribute("role", "listitem");
      btn.setAttribute("aria-label", "Play ranked " + rank + ": " + item.title);

      const rankEl = document.createElement("span");
      rankEl.className = "top10-card__rank";
      rankEl.textContent = String(rank);
      rankEl.setAttribute("aria-hidden", "true");

      const poster = document.createElement("div");
      poster.className = "top10-card__poster";
      if (item.poster_path) {
        const img = document.createElement("img");
        img.src = posterUrl(item.poster_path);
        img.alt = "";
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
        poster.appendChild(img);
      }

      btn.appendChild(rankEl);
      btn.appendChild(poster);
      btn.addEventListener("click", function () {
        loadMedia(item.id, item.media_type, { isAnime: item.isAnime });
      });
      container.appendChild(btn);
    });
  }

  function getCurrentTrendingItems() {
    if (mode === MODE_ANIME && catalog.anime.loaded) return catalog.anime.items;
    if (mode === MODE_TV && catalog.tv.loaded) return catalog.tv.items;
    if (catalog.movie.loaded) return catalog.movie.items;
    return [];
  }

  function rotateHeroToRandomTrending() {
    const list = getCurrentTrendingItems();
    if (list.length === 0) return;
    if (list.length === 1) {
      updateFeaturedHero(list[0]);
      return;
    }
    let idx = 0;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * list.length);
      attempts += 1;
    } while (
      attempts < 16 &&
      featuredItem &&
      list[idx].id === featuredItem.id &&
      list[idx].media_type === featuredItem.media_type
    );
    updateFeaturedHero(list[idx]);
  }

  function stopHeroAutoSwap() {
    if (heroRotationTimer !== null) {
      clearInterval(heroRotationTimer);
      heroRotationTimer = null;
    }
  }

  function startHeroAutoSwap() {
    stopHeroAutoSwap();
    const list = getCurrentTrendingItems();
    if (list.length === 0) return;
    heroRotationTimer = window.setInterval(rotateHeroToRandomTrending, HERO_SWAP_MS);
  }

  function syncHeroAndTop10FromCatalog(items) {
    if (!Array.isArray(items) || items.length === 0) {
      updateFeaturedHero(null);
      renderTop10(els.top10Grid, []);
      stopHeroAutoSwap();
      return;
    }
    updateFeaturedHero(items[0]);
    renderTop10(els.top10Grid, items);
    startHeroAutoSwap();
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

      const inner = document.createElement("div");
      inner.className = "media-card__inner";

      if (item.poster_path) {
        const img = document.createElement("img");
        img.src = posterUrl(item.poster_path);
        img.alt = "";
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
        inner.appendChild(img);
      }

      const overlay = document.createElement("div");
      overlay.className = "media-card-overlay";
      inner.appendChild(overlay);

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
      inner.appendChild(meta);

      btn.appendChild(inner);

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

      btn.addEventListener("click", function () {
        loadMedia(item.id, item.media_type, { isAnime: item.isAnime });
      });

      container.appendChild(btn);
    });
  }

  async function ensureMovieTrending() {
    if (catalog.movie.loaded) {
      renderMediaCards(els.trendingGrid, catalog.movie.items);
      syncHeroAndTop10FromCatalog(catalog.movie.items);
      return;
    }
    fillSkeletonRow(els.trendingGrid, TRENDING_COUNT);
    fillSkeletonTop10(els.top10Grid);
    try {
      const data = await tmdbFetch("/trending/movie/day", { page: 1 });
      const raw = Array.isArray(data.results) ? data.results.slice(0, TRENDING_COUNT) : [];
      catalog.movie.items = raw.map(function (m) {
        return normalizeMovie(m, false);
      });
      catalog.movie.loaded = true;
      renderMediaCards(els.trendingGrid, catalog.movie.items);
      syncHeroAndTop10FromCatalog(catalog.movie.items);
    } catch (e) {
      clearChildren(els.trendingGrid);
      renderTop10(els.top10Grid, []);
      updateFeaturedHero(null);
      stopHeroAutoSwap();
      showError("Could not load trending movies: " + (e.message || "Unknown error"));
    }
  }

  async function ensureTvTrending() {
    if (catalog.tv.loaded) {
      renderMediaCards(els.trendingGrid, catalog.tv.items);
      syncHeroAndTop10FromCatalog(catalog.tv.items);
      return;
    }
    fillSkeletonRow(els.trendingGrid, TRENDING_COUNT);
    fillSkeletonTop10(els.top10Grid);
    try {
      const data = await tmdbFetch("/trending/tv/day", { page: 1 });
      const raw = Array.isArray(data.results) ? data.results.slice(0, TRENDING_COUNT) : [];
      catalog.tv.items = raw.map(function (t) {
        return normalizeTv(t, false);
      });
      catalog.tv.loaded = true;
      renderMediaCards(els.trendingGrid, catalog.tv.items);
      syncHeroAndTop10FromCatalog(catalog.tv.items);
    } catch (e) {
      clearChildren(els.trendingGrid);
      renderTop10(els.top10Grid, []);
      updateFeaturedHero(null);
      stopHeroAutoSwap();
      showError("Could not load trending TV: " + (e.message || "Unknown error"));
    }
  }

  async function ensureAnimeCatalog() {
    if (catalog.anime.loaded) {
      renderMediaCards(els.trendingGrid, catalog.anime.items);
      syncHeroAndTop10FromCatalog(catalog.anime.items);
      return;
    }
    fillSkeletonRow(els.trendingGrid, TRENDING_COUNT);
    fillSkeletonTop10(els.top10Grid);
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
      syncHeroAndTop10FromCatalog(catalog.anime.items);
    } catch (e) {
      clearChildren(els.trendingGrid);
      renderTop10(els.top10Grid, []);
      updateFeaturedHero(null);
      stopHeroAutoSwap();
      showError("Could not load anime: " + (e.message || "Unknown error"));
    }
  }

  async function ensureNetflixRow() {
    if (!els.netflixGrid) return;
    if (catalog.netflix.loaded) {
      renderMediaCards(els.netflixGrid, catalog.netflix.items);
      return;
    }
    fillSkeletonRow(els.netflixGrid, 12);
    try {
      const data = await tmdbFetch("/discover/movie", {
        with_watch_providers: "8",
        watch_region: "US",
        sort_by: "popularity.desc",
        page: 1,
      });
      const raw = Array.isArray(data.results) ? data.results.slice(0, 20) : [];
      catalog.netflix.items = raw.map(function (m) {
        return normalizeMovie(m, false);
      });
      catalog.netflix.loaded = true;
      renderMediaCards(els.netflixGrid, catalog.netflix.items);
    } catch (e) {
      clearChildren(els.netflixGrid);
    }
  }

  function updateDiscoverTitles() {
    if (mode === MODE_ANIME) {
      els.trendingHeading.textContent = "Popular anime";
      els.trendingMeta.textContent = "Genre 16 · JA";
      if (els.top10Meta) els.top10Meta.textContent = "Anime picks";
    } else if (mode === MODE_TV) {
      els.trendingHeading.textContent = "Trending today";
      els.trendingMeta.textContent = "TV shows";
      if (els.top10Meta) els.top10Meta.textContent = "TV today";
    } else {
      els.trendingHeading.textContent = "Trending today";
      els.trendingMeta.textContent = "Movies";
      if (els.top10Meta) els.top10Meta.textContent = "Movies today";
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
    fillSkeletonRow(els.searchGrid, 12);
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

    if (els.featuredPlay) {
      els.featuredPlay.addEventListener("click", function () {
        if (!featuredItem) return;
        loadMedia(featuredItem.id, featuredItem.media_type, {
          isAnime: featuredItem.isAnime,
        });
      });
    }

    ensureNetflixRow();
    refreshDiscoverSection();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
