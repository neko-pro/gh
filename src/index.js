import { PhotonImage, grayscale, resize, SamplingFilter } from "@cf-wasm/photon";

const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100; // 100KB

export default {
  async fetch(request, env, ctx) {
    // 0. Tangani preflight CORS dari ekstensi browser
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

    // 1. AUTENTIKASI (Seperti src/authenticate.js di repo himshim)
    // Aktif otomatis hanya jika Anda mengatur variabel LOGIN dan PASSWORD di Settings Cloudflare Worker
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
      const base64Credentials = authHeader.slice(6);
      const credentials = atob(base64Credentials);
      const [login, password] = credentials.split(":");
      if (login !== env.LOGIN || password !== env.PASSWORD) {
        return new Response("Access denied", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Bandwidth-Hero Compression Service"',
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // 2. PARSING PARAMETER & VALIDASI (Seperti src/params.js di repo himshim)
    const reqUrl = new URL(request.url);
    const params = reqUrl.searchParams;

    let rawUrl = params.getAll("url").join("&");
    if (!rawUrl) {
      // Respon wajib untuk validasi ekstensi ayastreb/bandwidth-hero
      return new Response("bandwidth-hero-proxy", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "x-original-size, x-bytes-saved, content-length",
        },
      });
    }

    // Bersihkan URL dari injeksi proxy ISP (persis seperti di params.js himshim)
    rawUrl = rawUrl.replace(/http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, "http://");

    const webp = params.get("jpeg") !== "1";
    const bw = params.get("bw") !== "0" && params.get("bw") !== null && params.get("bw") !== "false";
    const quality = parseInt(params.get("l"), 10) || DEFAULT_QUALITY;

    // Fungsi Redirect identik dengan src/redirect.js
    const redirect = (locationUrl) => {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": encodeURI(locationUrl),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
          "Expires": "-1",
          "Pragma": "no-cache",
        },
      });
    };

    // Fungsi Pengecekan Kompresi identik dengan src/shouldCompress.js
    const shouldCompress = (originType, originSize, isWebp) => {
      if (!originType.startsWith("image")) return false;
      if (originSize === 0) return false;
      if (isWebp && originSize < MIN_COMPRESS_LENGTH) return false;
      if (
        !isWebp &&
        (originType.endsWith("png") || originType.endsWith("gif")) &&
        originSize < MIN_TRANSPARENT_COMPRESS_LENGTH
      ) {
        return false;
      }
      return true;
    };

    try {
      const targetUrl = new URL(rawUrl);

      // 3. FETCH GAMBAR ASLI (Seperti index.js di repo himshim + Spoofing Anti-Block)
      const fetchHeaders = new Headers({
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8",
        "Accept-Language": request.headers.get("Accept-Language") || "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": `${targetUrl.protocol}//${targetUrl.hostname}/`,
        "Origin": `${targetUrl.protocol}//${targetUrl.hostname}`,
        "Via": "1.1 bandwidth-hero",
      });

      // Teruskan Cookie jika ada (seperti di index.js himshim)
      const cookie = request.headers.get("cookie");
      if (cookie) {
        fetchHeaders.set("Cookie", cookie);
      }

      const originResponse = await fetch(rawUrl, {
        headers: fetchHeaders,
        redirect: "follow",
      });

      if (!originResponse.ok) {
        return redirect(rawUrl);
      }

      const originBuffer = new Uint8Array(await originResponse.arrayBuffer());
      const originSize = originBuffer.byteLength;
      const originType = (originResponse.headers.get("content-type") || "").toLowerCase();

      // Cek apakah memenuhi syarat kompresi (atau lewati jika GIF animasi / SVG / > 6MB)
      if (
        !shouldCompress(originType, originSize, webp) ||
        originType.includes("gif") ||
        originType.includes("svg") ||
        originSize > 6291456
      ) {
        return redirect(rawUrl);
      }

      // 4. PROSES KOMPRESI (Seperti src/compress.js di repo himshim)
      let workingImage = PhotonImage.new_from_byteslice(originBuffer);

      // Batasi ukuran maksimum (seperti limit pixel pada Sharp di himshim)
      const width = workingImage.get_width();
      const height = workingImage.get_height();
      const MAX_WIDTH = 1600;

      if (width > MAX_WIDTH) {
        const newHeight = Math.round((height * MAX_WIDTH) / width);
        const resized = resize(workingImage, MAX_WIDTH, newHeight, SamplingFilter.Lanczos3);
        workingImage.free();
        workingImage = resized;
      }

      if (bw) {
        grayscale(workingImage);
      }

      const clampedQuality = Math.min(Math.max(quality, 10), 95);
      const outputBuffer = workingImage.get_bytes_jpeg(clampedQuality);
      workingImage.free();

      const compressedSize = outputBuffer.byteLength;
      const bytesSaved = originSize - compressedSize;

      // Di compress.js himshim: jika hasil kompresi lebih besar dari ukuran asli (bytesSaved <= 0), redirect ke gambar asli
      // Namun jika bw=1 (hitam-putih), tetap kirim hasil agar warna hitam-putihnya tidak hilang
      if (bytesSaved <= 0 && !bw) {
        return redirect(rawUrl);
      }

      // 5. SALIN HEADER & KIRIM RESPON (Seperti src/copyHeaders.js & src/compress.js)
      const responseHeaders = new Headers();
      const excludedHeaders = [
        "host",
        "connection",
        "cf-ray",
        "cf-cache-status",
        "content-encoding",
        "content-length",
        "content-type",
        "transfer-encoding",
      ];

      for (const [key, value] of originResponse.headers.entries()) {
        if (!excludedHeaders.includes(key.toLowerCase())) {
          try {
            responseHeaders.set(key, value);
          } catch (_) {}
        }
      }

      responseHeaders.set("content-type", "image/jpeg");
      responseHeaders.set("content-length", compressedSize.toString());
      responseHeaders.set("x-original-size", originSize.toString());
      responseHeaders.set("x-bytes-saved", Math.max(bytesSaved, 0).toString());
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Expose-Headers", "x-original-size, x-bytes-saved, content-length");
      responseHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
      responseHeaders.set("Cache-Control", "public, max-age=604800, immutable");

      return new Response(outputBuffer, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      return redirect(rawUrl);
    }
  },
};
