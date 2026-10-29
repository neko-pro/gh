// ============================================================================
// BANDWIDTH HERO PROXY - MAXIMAL WSRV.NL + E-HENTAI (H@H) SUPPORT
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

    // Deteksi apakah URL berasal dari jaringan E-Hentai / ExHentai / Hentai@Home
    const isEHentaiUrl = (urlStr) => {
      try {
        const u = new URL(urlStr);
        const h = u.hostname.toLowerCase();
        return (
          h.includes("hath.network") ||
          h.includes("e-hentai.org") ||
          h.includes("exhentai.org") ||
          h.includes("ehgt.org") ||
          (u.port !== "" && u.port !== "80" && u.port !== "443") // Server dengan port non-standar
        );
      } catch (_) {
        return false;
      }
    };

    const getMangaSpoofHeaders = (targetUrlStr) => {
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
      } else if (
        host.includes("hath.network") ||
        host.includes("ehgt.org") ||
        host.includes("e-hentai.org")
      ) {
        // Khusus E-Hentai / H@H: Gunakan Referer utama dan jangan kirim header Origin
        refererOrigin = "https://e-hentai.org/";
        includeOrigin = false;
      } else if (host.includes("exhentai.org")) {
        refererOrigin = "https://exhentai.org/";
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

      const cookie = request.headers.get("cookie");
      if (cookie) headers.set("Cookie", cookie);
      return headers;
    };

    // =========================================================================
    // Endpoint Internal /raw (Jembatan Port Standar 443 & Spoofed Header)
    // Mengubah URL ber-port aneh (misal :12345 milik H@H) menjadi port 443 standar
    // sehingga wsrv.nl mau memprosesnya!
    // =========================================================================
    if (reqUrl.pathname === "/raw") {
      const targetImg = params.get("url");
      const sign = params.get("sign");

      if (!targetImg || sign !== INTERNAL_RAW_SIGN) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        const rawRes = await fetch(targetImg, {
          headers: getMangaSpoofHeaders(targetImg),
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
      const isSpecialPortOrEH = isEHentaiUrl(rawUrl);
      let wsrvRes = null;

      // Lapis 1: wsrv.nl langsung (LEWATI Lapis 1 jika URL berasal dari E-Hentai / Port Kustom,
      // karena wsrv.nl memblokir port selain 80/443 secara langsung)
      if (!isSpecialPortOrEH) {
        wsrvRes = await fetch(buildWsrvUrl(rawUrl), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // Lapis 2: wsrv.nl via /raw bypass
      // Di sini URL E-Hentai yang tadinya memakai port kustom (:12345) dibungkus oleh
      // endpoint /raw Worker kita (port 443 standar), sehingga wsrv.nl bisa mengompresinya!
      if (!wsrvRes || !wsrvRes.ok) {
        const proxiedRawUrl = `${reqUrl.origin}/raw?sign=${INTERNAL_RAW_SIGN}&url=${encodeURIComponent(rawUrl)}`;
        wsrvRes = await fetch(buildWsrvUrl(proxiedRawUrl), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(7500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // Lapis 3: Fallback WordPress Photon (Hanya untuk domain port standar 80/443)
      if ((!wsrvRes || !wsrvRes.ok) && !isSpecialPortOrEH) {
        const parsed = new URL(rawUrl);
        const wpUrl = new URL(`https://i0.wp.com/${parsed.host}${parsed.pathname}${parsed.search}`);
        wpUrl.searchParams.set("quality", effectiveQuality.toString());
        wpUrl.searchParams.set("strip", "all");
        wpUrl.searchParams.set("w", targetWidth);
        if (isBw) {
          wpUrl.searchParams.set("filter", "grayscale");
        }

        const wpHeaders = getMangaSpoofHeaders(rawUrl);
        wpHeaders.set("Accept", isJpeg ? "image/jpeg,image/*;q=0.8" : "image/webp,image/*;q=0.8");

        wsrvRes = await fetch(wpUrl.toString(), {
          headers: wpHeaders,
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // Lapis 4: Final Fallback Stream / Redirect
      // Jika node H@H E-Hentai mengunci token URL строго ke IP HP Anda (IP-locked),
      // maka hanya HP Anda yang diizinkan mengunduh gambar tersebut (server proxy mana pun akan ditolak 403).
      // Maka Worker akan melakukan Redirect 302 agar aplikasi Komikku di HP Anda mengunduhnya langsung.
      if (!wsrvRes || !wsrvRes.ok) {
        const directRes = await fetch(rawUrl, {
          headers: getMangaSpoofHeaders(rawUrl),
          redirect: "follow",
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);

        if (!directRes || !directRes.ok) {
          return Response.redirect(rawUrl, 302);
        }

        const cType = (directRes.headers.get("Content-Type") || "").toLowerCase();
        if (!cType.startsWith("image/")) {
          await directRes.body?.cancel();
          return Response.redirect(rawUrl, 302);
        }

        return new Response(directRes.body, {
          status: 200,
          headers: {
            "Content-Type": cType,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=604800, immutable",
          },
        });
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
