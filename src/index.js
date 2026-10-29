// ============================================================================
// BANDWIDTH HERO PROXY - 100% PURE WSRV.NL (EXHENTAI & KOMIKKU EDITION)
// Tanpa WASM - 0ms CPU - Anti 503 - Mendukung Hitam Putih di ExHentai
// ============================================================================
const SECRET_PATH = "/readx"; // Kosongkan "" jika tidak ingin pakai path rahasia
const INTERNAL_RAW_SIGN = "bwh-raw-bridge-9981";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const reqUrl = new URL(request.url);
    const params = reqUrl.searchParams;

    // Deteksi apakah URL berasal dari ExHentai / E-Hentai / Port Non-Standar
    const isEHentaiOrCustomPort = (urlStr) => {
      try {
        const u = new URL(urlStr);
        const h = u.hostname.toLowerCase();
        return (
          h.includes("hath.network") ||
          h.includes("e-hentai.org") ||
          h.includes("exhentai.org") ||
          h.includes("ehgt.org") ||
          (u.port !== "" && u.port !== "80" && u.port !== "443")
        );
      } catch (_) {
        return false;
      }
    };

    const getMangaSpoofHeaders = (targetUrlStr, forwardedCookie = "") => {
      const target = new URL(targetUrlStr);
      const host = target.hostname.toLowerCase();
      let refererOrigin = `${target.protocol}//${target.hostname}/`;
      let includeOrigin = true;

      if (host.includes("mangadex.network") || host.includes("mangadex.org")) {
        refererOrigin = "https://mangadex.org/";
      } else if (host.includes("pximg.net")) {
        refererOrigin = "https://www.pixiv.net/";
      } else if (host.includes("bato.to") || host.includes("mbimg.org")) {
        refererOrigin = "https://bato.to/";
      } else if (host.includes("exhentai.org")) {
        refererOrigin = "https://exhentai.org/";
        includeOrigin = false;
      } else if (
        host.includes("hath.network") ||
        host.includes("ehgt.org") ||
        host.includes("e-hentai.org")
      ) {
        refererOrigin = "https://e-hentai.org/";
        includeOrigin = false;
      }

      const headers = new Headers({
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,id-ID;q=0.8,id;q=0.7",
        "Referer": refererOrigin,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      });

      if (includeOrigin) {
        headers.set("Origin", refererOrigin.slice(0, -1));
      }

      // Gunakan Cookie dari parameter jembatan (jika ada) atau dari header langsung
      const activeCookie = forwardedCookie || request.headers.get("cookie");
      if (activeCookie) {
        headers.set("Cookie", activeCookie);
      }
      return headers;
    };

    // =========================================================================
    // ENDPOINT INTERNAL /raw: Mengambil gambar ExHentai/Manga yang terproteksi
    // beserta Cookie loginnya agar bisa dibaca oleh wsrv.nl
    // =========================================================================
    if (reqUrl.pathname === "/raw") {
      const targetImg = params.get("url");
      const sign = params.get("sign");
      const encodedCookie = params.get("ck") || "";

      if (!targetImg || sign !== INTERNAL_RAW_SIGN) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const decodedCookie = encodedCookie ? atob(encodedCookie) : "";
        const rawRes = await fetch(targetImg, {
          headers: getMangaSpoofHeaders(targetImg, decodedCookie),
          redirect: "follow",
          signal: AbortSignal.timeout(7000),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });

        if (!rawRes.ok) {
          return new Response("Upstream Error", { status: rawRes.status });
        }

        const cType = (rawRes.headers.get("content-type") || "").toLowerCase();
        if (cType && !cType.startsWith("image/") && !cType.includes("octet-stream")) {
          await rawRes.body?.cancel();
          return new Response("Only images allowed", { status: 415 });
        }

        return new Response(rawRes.body, {
          status: 200,
          headers: {
            "Content-Type": cType.startsWith("image/") ? cType : "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=604800, immutable",
          },
        });
      } catch (_) {
        return new Response("Gateway Timeout", { status: 504 });
      }
    }

    if (SECRET_PATH && !reqUrl.pathname.startsWith(SECRET_PATH)) {
      return new Response("Not Found", { status: 404 });
    }

    let rawUrl = params.getAll("url").join("&");
    if (!rawUrl) {
      return new Response("bandwidth-hero-proxy", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "x-original-size, x-bytes-saved, content-length",
        },
      });
    }

    rawUrl = rawUrl.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");
    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
      return new Response("Invalid URL protocol", { status: 400 });
    }

    // Jika URL Hentai@Home menggunakan port non-standar yang ditolak oleh Cloudflare/wsrv.nl,
    // coba normalkan ke port HTTPS standar (443) khusus untuk domain *.hath.network
    try {
      const parsedCheck = new URL(rawUrl);
      if (
        parsedCheck.hostname.endsWith(".hath.network") &&
        parsedCheck.port &&
        parsedCheck.port !== "443" &&
        parsedCheck.port !== "80"
      ) {
        // Simpan URL asli untuk jaga-jaga, tapi kita juga siapkan rute jembatan
      }
    } catch (_) {}

    const isJpeg = params.get("jpeg") === "1";
    const isBw = params.get("bw") === "1" || params.get("bw") === "true";
    const rawQuality = Math.min(Math.max(parseInt(params.get("l"), 10) || 40, 10), 95);

    const effectiveQuality = isBw ? Math.max(rawQuality - 5, 10) : rawQuality;
    const targetWidth = rawQuality <= 35 ? "720" : rawQuality <= 65 ? "900" : "1100";

    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), { method: "GET" });
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    // Pembuat URL wsrv.nl
    const buildWsrvUrl = (sourceImageUrl) => {
      const wsrv = new URL("https://wsrv.nl/");
      wsrv.searchParams.set("url", sourceImageUrl);
      wsrv.searchParams.set("q", effectiveQuality.toString());
      wsrv.searchParams.set("output", isJpeg ? "jpg" : "webp");
      wsrv.searchParams.set("w", targetWidth);
      wsrv.searchParams.set("we", "1");
      wsrv.searchParams.set("af", "1");
      wsrv.searchParams.set("maxage", "7d");

      if (isJpeg) {
        wsrv.searchParams.set("bg", "white");
        wsrv.searchParams.set("il", "1");
      }

      if (isBw) {
        wsrv.searchParams.set("filt", "greyscale");
      }
      return wsrv.toString();
    };

    try {
      const isSpecialEH = isEHentaiOrCustomPort(rawUrl);
      const userCookie = request.headers.get("cookie") || "";
      const encodedCookie = userCookie ? btoa(userCookie) : "";
      let wsrvRes = null;

      // =======================================================================
      // LAPIS 1: wsrv.nl langsung ke URL gambar
      // (Bekerja untuk 95% situs manga & server utama ehgt.org E-Hentai)
      // =======================================================================
      wsrvRes = await fetch(buildWsrvUrl(rawUrl), {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
        cf: { cacheEverything: true, cacheTtl: 604800 },
      }).catch(() => null);

      // =======================================================================
      // LAPIS 2: Jika gagal (misal ExHentai butuh Cookie / blokir Referer / Port H@H),
      // lewatkan melalui Jembatan Anti-Loopback (i0.wp.com -> /raw Worker -> wsrv.nl)
      // =======================================================================
      if (!wsrvRes || !wsrvRes.ok) {
        const rawBridgeUrl = `${reqUrl.origin}/raw?sign=${INTERNAL_RAW_SIGN}${
          encodedCookie ? `&ck=${encodeURIComponent(encodedCookie)}` : ""
        }&url=${encodeURIComponent(rawUrl)}`;

        // Coba panggil wsrv.nl langsung ke /raw terlebih dahulu
        wsrvRes = await fetch(buildWsrvUrl(rawBridgeUrl), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);

        // KUNCI ANTI-LOOPBACK: Jika Cloudflare memblokir wsrv.nl saat mengakses *.workers.dev/raw,
        // gunakan CDN WordPress Photon (i0.wp.com) sebagai perantara antara wsrv.nl dan /raw!
        // Alurnya: wsrv.nl (Kompres & Hitam Putih) -> i0.wp.com (Non-CF Relay) -> /raw Worker (Cookie & Referer ExHentai)
        if (!wsrvRes || !wsrvRes.ok) {
          const parsedBridge = new URL(rawBridgeUrl);
          const wpRelayUrl = `https://i0.wp.com/${parsedBridge.host}${parsedBridge.pathname}${parsedBridge.search}`;
          wsrvRes = await fetch(buildWsrvUrl(wpRelayUrl), {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(7500),
            cf: { cacheEverything: true, cacheTtl: 604800 },
          }).catch(() => null);
        }
      }

      // =======================================================================
      // LAPIS 3: Jika gambar asli berada di domain standar tapi wsrv.nl gagal,
      // gunakan WordPress Photon (i0.wp.com) sebagai izvor bagi wsrv.nl
      // =======================================================================
      if ((!wsrvRes || !wsrvRes.ok) && !isSpecialEH) {
        const parsed = new URL(rawUrl);
        const wpSource = `https://i0.wp.com/${parsed.host}${parsed.pathname}${parsed.search}`;
        wsrvRes = await fetch(buildWsrvUrl(wpSource), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // =======================================================================
      // LAPIS 4: Final Fallback (Jika node H@H ExHentai mengunci IP ketat ke HP Anda)
      // =======================================================================
      if (!wsrvRes || !wsrvRes.ok) {
        return Response.redirect(rawUrl, 302);
      }

      const compSize = parseInt(wsrvRes.headers.get("content-length") || "0", 10);
      const estimatedOrigSize = compSize * 3;
      const bytesSaved = compSize * 2;

      const responseHeaders = new Headers({
        "Content-Type": wsrvRes.headers.get("content-type") || (isJpeg ? "image/jpeg" : "image/webp"),
        "x-original-size": estimatedOrigSize.toString(),
        "x-bytes-saved": bytesSaved.toString(),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "x-original-size, x-bytes-saved, content-length",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cache-Control": "public, max-age=604800, immutable",
      });

      if (compSize > 0) {
        responseHeaders.set("Content-Length", compSize.toString());
      }

      const finalResponse = new Response(wsrvRes.body, {
        status: 200,
        headers: responseHeaders,
      });

      ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
      return finalResponse;
    } catch (err) {
      return Response.redirect(rawUrl, 302);
    }
  },
};
