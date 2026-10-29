// ============================================================================
// BANDWIDTH HERO PROXY - FINAL OPTIMIZED 100% WSRV.NL (KOMIKKU & EXHENTAI)
// Fitur: 0ms CPU Streaming, Adaptive Width, Cache 7 Hari, Anti-Loopback Relay
// ============================================================================
const SECRET_PATH = "/readx"; // Kosongkan "" jika tidak ingin pakai path rahasia
const INTERNAL_RAW_SIGN = "bwh-raw-bridge-9981";

export default {
  async fetch(request, env, ctx) {
    // 0. Tangani preflight CORS
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

    // Keamanan ToS: Hanya izinkan metode GET dan HEAD
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const reqUrl = new URL(request.url);
    const params = reqUrl.searchParams;

    // 1. Deteksi apakah URL berasal dari ExHentai / E-Hentai / Port Non-Standar
    const isProtectedOrCustomPort = (urlStr) => {
      try {
        const u = new URL(urlStr);
        const h = u.hostname.toLowerCase();
        return (
          h.includes("hath.network") ||
          h.includes("e-hentai.org") ||
          h.includes("exhentai.org") ||
          h.includes("ehgt.org") ||
          h.includes("pximg.net") ||
          (u.port !== "" && u.port !== "80" && u.port !== "443")
        );
      } catch (_) {
        return false;
      }
    };

    // 2. Pembuat Header Penyamaran (Spoofed Referer & Cookie)
    const getMangaSpoofHeaders = (targetUrlStr, forwardedCookie = "") => {
      const target = new URL(targetUrlStr);
      const host = target.hostname.toLowerCase();
      let refererOrigin = `${target.protocol}//${target.hostname}/`;
      let includeOrigin = true;

      if (host.includes("mangadex.network") || host.includes("mangadex.org")) {
        refererOrigin = "https://mangadex.org/";
      } else if (host.includes("pximg.net") || host.includes("pixiv.net")) {
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

      const activeCookie = forwardedCookie || request.headers.get("cookie");
      if (activeCookie) {
        headers.set("Cookie", activeCookie);
      }
      return headers;
    };

    // =========================================================================
    // ENDPOINT INTERNAL: /raw/image.jpg
    // Mengambil gambar mentah yang terblokir untuk disuapkan ke wsrv.nl
    // =========================================================================
    if (reqUrl.pathname.startsWith("/raw")) {
      const targetImg = params.get("url");
      const sign = params.get("sign");
      const encodedCookie = params.get("ck") || "";

      if (!targetImg || sign !== INTERNAL_RAW_SIGN) {
        return new Response("Forbidden", { status: 403 });
      }

      try {
        let decodedCookie = "";
        if (encodedCookie) {
          try {
            decodedCookie = atob(encodedCookie);
          } catch (_) {}
        }

        let rawRes = await fetch(targetImg, {
          headers: getMangaSpoofHeaders(targetImg, decodedCookie),
          redirect: "follow",
          signal: AbortSignal.timeout(7000),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);

        // Jika gagal karena port non-standar Hentai@Home (misal :12345),
        // otomatis coba ulang dengan menghapus port (memakai port 443 standar)
        if (!rawRes || !rawRes.ok) {
          const u = new URL(targetImg);
          if (u.port && u.port !== "443" && u.port !== "80") {
            u.port = "";
            rawRes = await fetch(u.toString(), {
              headers: getMangaSpoofHeaders(u.toString(), decodedCookie),
              redirect: "follow",
              signal: AbortSignal.timeout(6500),
              cf: { cacheEverything: true, cacheTtl: 604800 },
            }).catch(() => null);
          }
        }

        if (!rawRes || !rawRes.ok) {
          return new Response("Upstream Error", { status: rawRes ? rawRes.status : 502 });
        }

        // Keamanan ToS: Hanya izinkan konten gambar
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

    // 3. Validasi Secret Path (jika diisi)
    if (SECRET_PATH && !reqUrl.pathname.startsWith(SECRET_PATH)) {
      return new Response("Not Found", { status: 404 });
    }

    // 4. Parsing Parameter dari Aplikasi Komikku
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

    // Optimasi Penghematan Data:
    // - Turunkan kualitas 5 poin saat Hitam-Putih aktif (tetap tajam namun jauh lebih kecil)
    // - Sesuaikan lebar maksimum dengan level kualitas yang dipilih di Komikku
    const effectiveQuality = isBw ? Math.max(rawQuality - 5, 10) : rawQuality;
    const targetWidth = rawQuality <= 35 ? "720" : rawQuality <= 65 ? "900" : "1100";

    // 5. Cek Cache Edge Cloudflare
    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), { method: "GET" });
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    // 6. Pembuat URL Kompresi wsrv.nl (100% Kompatibel WebP & JPEG)
    const buildWsrvUrl = (sourceImageUrl) => {
      const wsrv = new URL("https://wsrv.nl/");
      wsrv.searchParams.set("url", sourceImageUrl);
      wsrv.searchParams.set("q", effectiveQuality.toString());
      wsrv.searchParams.set("output", isJpeg ? "jpg" : "webp");
      wsrv.searchParams.set("w", targetWidth);
      wsrv.searchParams.set("we", "1"); // Jangan perbesar gambar kecil
      wsrv.searchParams.set("maxage", "7d"); // Simpan di CDN wsrv.nl selama 7 hari

      if (isJpeg) {
        wsrv.searchParams.set("bg", "white"); // Mencegah PNG transparan jadi hitam pekat
        wsrv.searchParams.set("il", ""); // Progressive JPEG & optimasi tabel Huffman
      }

      if (isBw) {
        wsrv.searchParams.set("filt", "greyscale");
      }
      return wsrv.toString();
    };

    try {
      const isProtected = isProtectedOrCustomPort(rawUrl);
      const userCookie = request.headers.get("cookie") || "";
      let encodedCookie = "";
      if (userCookie) {
        try {
          encodedCookie = btoa(userCookie);
        } catch (_) {}
      }

      let wsrvRes = null;

      // Rute 1: wsrv.nl mengambil langsung dari URL sumber
      let cleanUrlForWsrv = rawUrl;
      if (isProtected) {
        try {
          const u = new URL(rawUrl);
          if (u.hostname.endsWith(".hath.network") && u.port && u.port !== "443" && u.port !== "80") {
            u.port = ""; // Normalkan ke port 443 standar pada node H@H
            cleanUrlForWsrv = u.toString();
          }
        } catch (_) {}
      }

      wsrvRes = await fetch(buildWsrvUrl(cleanUrlForWsrv), {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
        cf: { cacheEverything: true, cacheTtl: 604800 },
      }).catch(() => null);

      // Rute 2: Jika ditolak karena Referer/Cookie/Port, suapkan ke wsrv.nl melalui /raw/image.jpg
      if (!wsrvRes || !wsrvRes.ok) {
        const rawBridgeUrl = `${reqUrl.origin}/raw/image.jpg?sign=${INTERNAL_RAW_SIGN}${
          encodedCookie ? `&ck=${encodeURIComponent(encodedCookie)}` : ""
        }&url=${encodeURIComponent(rawUrl)}`;

        // 2A: wsrv.nl -> /raw/image.jpg
        wsrvRes = await fetch(buildWsrvUrl(rawBridgeUrl), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);

        // 2B: Anti-Loopback via perantara Non-Cloudflare (i0.wp.com) lalu masukkan ke wsrv.nl
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

      // Rute 3: Gunakan i0.wp.com sebagai pengambil sumber asli, lalu suapkan ke wsrv.nl
      if (!wsrvRes || !wsrvRes.ok) {
        const parsed = new URL(cleanUrlForWsrv);
        const wpSource = `https://i0.wp.com/${parsed.host}${parsed.pathname}${parsed.search}`;
        wsrvRes = await fetch(buildWsrvUrl(wpSource), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // Rute 4: Final Fallback Redirect (Jika semua jembatan ditolak karena IP-Lock ketat)
      if (!wsrvRes || !wsrvRes.ok) {
        return Response.redirect(rawUrl, 302);
      }

      // 7. Streaming Hasil Kompresi ke Komikku (0 MB RAM)
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
