import { PhotonImage, grayscale, resize, SamplingFilter } from "@cf-wasm/photon";

const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 50; // 50KB

// Batas aman proses WASM di Tier Gratis agar tidak pernah kena 503 (CPU > 10ms / RAM > 128MB)
const MAX_WASM_SIZE = 1.2 * 1024 * 1024; // 1.2 MB

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

    const reqUrl = new URL(request.url);
    const params = reqUrl.searchParams;

    // Fungsi pembuat header penyamaran (Anti-Hotlink)
    const getSpoofedHeaders = (targetUrlStr) => {
      const target = new URL(targetUrlStr);
      const h = new Headers({
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8",
        "Accept-Language": request.headers.get("Accept-Language") || "id-ID,id;q=0.9,en-US;q=0.8",
        "Referer": `${target.protocol}//${target.hostname}/`,
        "Origin": `${target.protocol}//${target.hostname}`,
        "Via": "1.1 bandwidth-hero",
      });
      const cookie = request.headers.get("cookie");
      if (cookie) h.set("Cookie", cookie);
      return h;
    };

    // =========================================================================
    // ENDPOINT /raw: Mengalirkan gambar besar (>1.2MB) dengan Spoofed Header
    // tanpa memakan RAM/CPU Worker (Streaming langsung)
    // =========================================================================
    if (reqUrl.pathname === "/raw") {
      const targetImg = params.get("url");
      if (!targetImg) return new Response("Missing URL", { status: 400 });
      try {
        const res = await fetch(targetImg, {
          headers: getSpoofedHeaders(targetImg),
          redirect: "follow",
          cf: { cacheEverything: true, cacheTtl: 86400 },
        });
        return new Response(res.body, {
          status: res.status,
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (_) {
        return Response.redirect(targetImg, 302);
      }
    }

    // 1. AUTENTIKASI (Opsional)
    if (env && env.LOGIN && env.PASSWORD) {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Basic ")) {
        return new Response("Access denied", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Bandwidth-Hero Compression Service"',
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      const [login, password] = atob(authHeader.slice(6)).split(":");
      if (login !== env.LOGIN || password !== env.PASSWORD) {
        return new Response("Access denied", { status: 401 });
      }
    }

    // 2. PARSING PARAMETER & VALIDASI EKSTENSI
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

    const webp = params.get("jpeg") !== "1";
    const bw = params.get("bw") === "1" || params.get("bw") === "true";
    const quality = Math.min(Math.max(parseInt(params.get("l"), 10) || DEFAULT_QUALITY, 10), 95);

    // 3. CEK CLOUDFLARE EDGE CACHE
    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), { method: "GET" });
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    const redirect = (locationUrl) => {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": encodeURI(locationUrl),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
        },
      });
    };

    // Fungsi Fallback Kompresi Eksternal untuk Gambar Raksasa (> 1.2 MB) agar Worker tidak kena 503
    const offloadHeavyImage = async (targetImgUrl, originalSize) => {
      try {
        const proxiedRawUrl = `${reqUrl.origin}/raw?url=${encodeURIComponent(targetImgUrl)}`;
        const wsrvUrl = new URL("https://wsrv.nl/");
        wsrvUrl.searchParams.set("url", proxiedRawUrl);
        wsrvUrl.searchParams.set("q", quality.toString());
        wsrvUrl.searchParams.set("output", webp ? "webp" : "jpg");
        wsrvUrl.searchParams.set("w", "1000");
        wsrvUrl.searchParams.set("we", "1"); // Jangan perbesar jika gambar kecil
        if (bw) wsrvUrl.searchParams.set("filt", "greyscale");

        const extRes = await fetch(wsrvUrl.toString(), { signal: AbortSignal.timeout(6000) });
        if (!extRes.ok) return redirect(targetImgUrl);

        const buf = await extRes.arrayBuffer();
        const compSize = buf.byteLength;
        const saved = Math.max((originalSize || compSize * 3) - compSize, 0);

        const res = new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": webp ? "image/webp" : "image/jpeg",
            "Content-Length": compSize.toString(),
            "x-original-size": (originalSize || compSize * 3).toString(),
            "x-bytes-saved": saved.toString(),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "x-original-size, x-bytes-saved, content-length",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "public, max-age=604800, immutable",
          },
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (_) {
        return redirect(targetImgUrl);
      }
    };

    let workingImage = null;

    try {
      const originResponse = await fetch(rawUrl, {
        headers: getSpoofedHeaders(rawUrl),
        redirect: "follow",
        signal: AbortSignal.timeout(6500),
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });

      if (!originResponse.ok) {
        return redirect(rawUrl);
      }

      const originType = (originResponse.headers.get("content-type") || "").toLowerCase();
      if (!originType.startsWith("image") || originType.includes("gif") || originType.includes("svg")) {
        return redirect(rawUrl);
      }

      // 4. CEK UKURAN SEBELUM MASUK KE RAM WASM (KUNCI ANTI-503)
      const declaredLength = parseInt(originResponse.headers.get("content-length") || "0", 10);
      if (declaredLength > MAX_WASM_SIZE) {
        // Batalkan stream unduhan di Worker, alihkan ke jalur hemat CPU
        await originResponse.body?.cancel();
        return await offloadHeavyImage(rawUrl, declaredLength);
      }

      let originBuffer = new Uint8Array(await originResponse.arrayBuffer());
      const originSize = originBuffer.byteLength;

      // Jika ternyata ukurannya terlalu kecil, lewati
      if (
        originSize === 0 ||
        (webp && originSize < MIN_COMPRESS_LENGTH) ||
        (!webp && (originType.endsWith("png") || originType.endsWith("gif")) && originSize < MIN_TRANSPARENT_COMPRESS_LENGTH)
      ) {
        return redirect(rawUrl);
      }

      // Jika server tidak mengirim header Content-Length tapi ternyata file aslinya > 1.2 MB
      if (originSize > MAX_WASM_SIZE) {
        originBuffer = null; // Kosongkan RAM segera
        return await offloadHeavyImage(rawUrl, originSize);
      }

      // 5. PROSES WASM SUPER RINGAN (< 5ms CPU)
      workingImage = PhotonImage.new_from_byteslice(originBuffer);
      originBuffer = null; // Bebaskan buffer asli dari RAM V8 secepat mungkin

      const width = workingImage.get_width();
      const height = workingImage.get_height();

      // Jika resolusi gambar terlalu tinggi (> 4.5 Megapixel, misal 2500x2000px),
      // batalkan proses WASM agar RAM 128MB tidak jebol
      if (width * height > 4500000) {
        workingImage.free();
        workingImage = null;
        return await offloadHeavyImage(rawUrl, originSize);
      }

      const maxWidth = quality <= 25 ? 800 : quality <= 50 ? 1024 : 1280;

      if (width > maxWidth) {
        const newHeight = Math.round((height * maxWidth) / width);
        // SamplingFilter.Nearest adalah filter paling ringan CPU (mencegah Error 503 / 1102)
        const resized = resize(workingImage, maxWidth, newHeight, SamplingFilter.Nearest);
        workingImage.free();
        workingImage = resized;
      }

      if (bw) {
        grayscale(workingImage);
      }

      const outputBuffer = workingImage.get_bytes_jpeg(quality);
      workingImage.free();
      workingImage = null;

      const compressedSize = outputBuffer.byteLength;
      const bytesSaved = originSize - compressedSize;

      if (bytesSaved <= 0 && !bw) {
        return redirect(rawUrl);
      }

      const finalResponse = new Response(outputBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": compressedSize.toString(),
          "x-original-size": originSize.toString(),
          "x-bytes-saved": Math.max(bytesSaved, 0).toString(),
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "x-original-size, x-bytes-saved, content-length",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cache-Control": "public, max-age=604800, immutable",
        },
      });

      ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
      return finalResponse;
    } catch (err) {
      return redirect(rawUrl);
    } finally {
      if (workingImage) {
        try {
          workingImage.free();
        } catch (_) {}
      }
    }
  },
};
