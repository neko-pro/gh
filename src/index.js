import { PhotonImage, grayscale, resize, SamplingFilter } from "@cf-wasm/photon";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;

    const imageUrl = params.get("url");
    if (!imageUrl) {
      return new Response("Bandwidth Hero WASM Proxy v2 is running!", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Parameter dari Bandwidth Hero
    const isBw = params.get("bw") === "1" || params.get("bw") === "true";
    const quality = Math.min(Math.max(parseInt(params.get("l") || "40", 10), 10), 95);
    const maxWidth = parseInt(params.get("max_width") || "1280", 10);

    try {
      const targetUrl = new URL(imageUrl);

      // 1. Jangan minta image/avif di Accept header karena WASM Photon belum mendukung dekode AVIF
      const fetchHeaders = new Headers({
        "User-Agent":
          request.headers.get("User-Agent") ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": `${targetUrl.protocol}//${targetUrl.hostname}/`,
        "Origin": `${targetUrl.protocol}//${targetUrl.hostname}`,
      });

      const imgResponse = await fetch(imageUrl, {
        headers: fetchHeaders,
        redirect: "follow",
      });

      if (!imgResponse.ok) {
        return Response.redirect(imageUrl, 302);
      }

      const contentType = (imgResponse.headers.get("content-type") || "").toLowerCase();
      const originalBuffer = new Uint8Array(await imgResponse.arrayBuffer());
      const originalSize = originalBuffer.byteLength;

      // Lewati jika GIF animasi atau SVG, atau ukuran di atas 6MB (mencegah CPU limit)
      if (
        contentType.includes("gif") ||
        contentType.includes("svg") ||
        originalSize > 6291456
      ) {
        return new Response(originalBuffer, {
          status: 200,
          headers: {
            "Content-Type": contentType || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
          },
        });
      }

      // 2. Dekode gambar ke dalam memori WASM
      let workingImage = PhotonImage.new_from_byteslice(originalBuffer);

      // 3. Perkecil resolusi jika gambar terlalu lebar (opsional, menghemat ukuran file secara signifikan)
      const width = workingImage.get_width();
      const height = workingImage.get_height();

      if (width > maxWidth) {
        const newHeight = Math.round((height * maxWidth) / width);
        const resizedImage = resize(workingImage, maxWidth, newHeight, SamplingFilter.Lanczos3);
        workingImage.free(); // Bebaskan gambar lama dari RAM
        workingImage = resizedImage;
      }

      // 4. Terapkan filter Hitam Putih jika bw=1
      if (isBw) {
        grayscale(workingImage);
      }

      // 5. Kompres menggunakan encoder Lossy JPEG sesuai parameter quality (l)
      // Catatan: get_bytes_webp() di Photon menggunakan Lossless WebP yang membuat ukuran membengkak,
      // sedangkan get_bytes_jpeg(quality) mendukung kompresi lossy yang jauh lebih kecil.
      const outputBuffer = workingImage.get_bytes_jpeg(quality);

      // Bebaskan memori WASM
      workingImage.free();

      const compressedSize = outputBuffer.byteLength;
      const bytesSaved = originalSize > compressedSize ? originalSize - compressedSize : 0;

      // 6. Kembalikan gambar hasil kompresi + Header indikator Bandwidth Hero
      return new Response(outputBuffer, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": compressedSize.toString(),
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Original-Size": originalSize.toString(),
          "X-Bytes-Saved": bytesSaved.toString(),
          "X-Proxy-Status": "COMPRESSED-WASM",
        },
      });
    } catch (error) {
      // Jika gagal (misal format gambar korup/tidak didukung), tambahkan header X-Proxy-Error agar mudah dicek
      return new Response(null, {
        status: 302,
        headers: {
          "Location": imageUrl,
          "X-Proxy-Error": error.message || "WASM_ERROR",
        },
      });
    }
  },
};
