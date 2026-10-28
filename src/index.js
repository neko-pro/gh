// ============================================================================
// KONFIGURASI KEAMANAN (Ganti SECRET_TOKEN sesuai keinginan Anda)
// Jika diisi, URL di Komikku menjadi: https://nama-worker.workers.dev/rahasia123
// Jika dikosongkan (""), bisa diakses langsung di: https://nama-worker.workers.dev
// ============================================================================
const SECRET_PATH = "/readx"; // Contoh: "/komikku-saya" (kosongkan "" jika tidak ingin pakai path rahasia)
const INTERNAL_RAW_SIGN = "bwh-raw-bridge-9981"; // Kunci internal agar endpoint /raw tidak jadi Open Proxy

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

    // Tolak metode selain GET dan HEAD (Keamanan ToS)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const reqUrl = new URL(request.url);
    const params = reqUrl.searchParams;

    // 1. Fungsi pembuat Header Penyamaran (Khusus Server Manga Ketat seperti Mangadex, Bato, Kakao, dll.)
    const getMangaSpoofHeaders = (targetUrlStr) => {
      const target = new URL(targetUrlStr);
      let refererOrigin = `${target.protocol}//${target.hostname}/`;

      // Penanganan khusus untuk CDN manga populer yang mengecek domain utama
      if (target.hostname.includes("mangadex.network") || target.hostname.includes("mangadex.org")) {
        refererOrigin = "https://mangadex.org/";
      } else if (target.hostname.includes("pximg.net")) {
        refererOrigin = "https://www.pixiv.net/";
      } else if (target.hostname.includes("bato.to") || target.hostname.includes("mbimg.org")) {
        refererOrigin = "https://bato.to/";
      }

      const headers = new Headers({
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": refererOrigin,
        "Origin": refererOrigin.slice(0, -1),
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      });

      const cookie = request.headers.get("cookie");
      if (cookie) headers.set("Cookie", cookie);
      return headers;
    };

    // =========================================================================
    // ENDPOINT INTERNAL: /raw (Hanya dipanggil jika wsrv.nl diblokir langsung)
    // Dilindungi INTERNAL_RAW_SIGN & validasi khusus image/* agar 100% aman ToS
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
          cf: { cacheEverything: true, cacheTtl: 86400 },
        });

        if (!rawRes.ok) {
          return new Response("Upstream Error", { status: rawRes.status });
        }

        // KEAMANAN TOS: Pastikan file yang lewat benar-benar gambar (tolak video/binary/html)
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
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (_) {
        return new Response("Gateway Timeout", { status: 504 });
      }
    }

    // 2. CEK SECRET PATH (Jika diaktifkan oleh pengguna)
    if (SECRET_PATH && !reqUrl.pathname.startsWith(SECRET_PATH)) {
      return new Response("Not Found", { status: 404 });
    }

    // 3. PARSING PARAMETER DARI KOMIKKU / BANDWIDTH HERO
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

    // Bersihkan URL dari injeksi proxy ISP & validasi protokol HTTP/HTTPS
    rawUrl = rawUrl.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");
    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
      return new Response("Invalid URL protocol", { status: 400 });
    }

    // Parameter Komikku: jpeg (0 = WebP, 1 = JPEG), bw (0/1), l (1-100 kualitas)
    const isJpeg = params.get("jpeg") === "1";
    const isBw = params.get("bw") === "1" || params.get("bw") === "true";
    const quality = Math.min(Math.max(parseInt(params.get("l"), 10) || 40, 10), 95);

    // 4. CEK CLOUDFLARE EDGE CACHE (0ms CPU & Hemat Kuota Harian)
    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), { method: "GET" });
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    // Fungsi pembuat URL wsrv.nl yang dioptimalkan untuk Manga / Webtoon (Long-Strip)
    const buildWsrvUrl = (sourceImageUrl) => {
      const wsrv = new URL("https://wsrv.nl/");
      wsrv.searchParams.set("url", sourceImageUrl);
      wsrv.searchParams.set("q", quality.toString());
      wsrv.searchParams.set("output", isJpeg ? "jpg" : "webp");
      wsrv.searchParams.set("n", "-1"); // Dukungan gambar multi-halaman/animasi jika ada
      // Penting untuk Komikku: jangan batasi tinggi (height) karena Webtoon/Manhwa sangat panjang,
      // cukup batasi lebar (width) maksimum ke 1200px jika gambar terlalu lebar (`we` = without enlargement)
      wsrv.searchParams.set("w", "1200");
      wsrv.searchParams.set("we", "1");
      if (isBw) {
        wsrv.searchParams.set("filt", "greyscale");
      }
      return wsrv.toString();
    };

    try {
      // =======================================================================
      // LAPIS 1: Minta wsrv.nl mengambil langsung ke server gambar
      // =======================================================================
      let wsrvRes = await fetch(buildWsrvUrl(rawUrl), {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6500),
        cf: { cacheEverything: true, cacheTtl: 604800 },
      }).catch(() => null);

      // =======================================================================
      // LAPIS 2 (ANTI-BLOCK): Jika wsrv.nl diblokir oleh server manga (403/404/5xx),
      // gunakan jembatan /raw milik Worker yang menyamarkan Referer & User-Agent!
      // =======================================================================
      if (!wsrvRes || !wsrvRes.ok) {
        const proxiedRawUrl = `${reqUrl.origin}/raw?sign=${INTERNAL_RAW_SIGN}&url=${encodeURIComponent(rawUrl)}`;
        wsrvRes = await fetch(buildWsrvUrl(proxiedRawUrl), {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(7500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // =======================================================================
      // LAPIS 3 (FALLBACK CDN): Jika wsrv.nl sedang gangguan atau gambar terlalu panjang
      // (>16383px untuk WebP), gunakan WordPress Jetpack Photon CDN (i0.wp.com)
      // =======================================================================
      if (!wsrvRes || !wsrvRes.ok) {
        const parsed = new URL(rawUrl);
        const wpUrl = new URL(`https://i0.wp.com/${parsed.host}${parsed.pathname}${parsed.search}`);
        wpUrl.searchParams.set("quality", quality.toString());
        wpUrl.searchParams.set("strip", "all");

        wsrvRes = await fetch(wpUrl.toString(), {
          headers: getMangaSpoofHeaders(rawUrl),
          signal: AbortSignal.timeout(6500),
          cf: { cacheEverything: true, cacheTtl: 604800 },
        }).catch(() => null);
      }

      // =======================================================================
      // LAPIS 4 (FINAL FALLBACK): Jika semua kompresor gagal (misal Webtoon super
      // panjang yang ditolak semua resizer), stream langsung gambar asli via Worker
      // dengan Spoofed Referer agar halaman di Komikku TIDAK PERNAH gagal muat!
      // =======================================================================
      if (!wsrvRes || !wsrvRes.ok) {
        const directRes = await fetch(rawUrl, {
          headers: getMangaSpoofHeaders(rawUrl),
          redirect: "follow",
          signal: AbortSignal.timeout(7000),
          cf: { cacheEverything: true, cacheTtl: 86400 },
        });

        if (!directRes.ok) {
          return Response.redirect(rawUrl, 302);
        }

        return new Response(directRes.body, {
          status: 200,
          headers: {
            "Content-Type": directRes.headers.get("Content-Type") || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }

      // 5. STREAMING RESPON HASIL KOMPRESI KE KOMIKKU (0 MB RAM)
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

      // Gunakan wsrvRes.body secara langsung (ReadableStream) tanpa memuat ke ArrayBuffer
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
