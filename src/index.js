import { PhotonImage, grayscale } from "@cf-wasm/photon";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;

    const imageUrl = params.get("url");
    if (!imageUrl) {
      return new Response("Bandwidth Hero WASM Proxy is running!", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const isJpeg = params.get("jpeg") === "1";
    const isBw = params.get("bw") === "1";
    const quality = parseInt(params.get("l") || "40", 10);

    try {
      const targetUrl = new URL(imageUrl);

      // Spoofing Header untuk menembus proteksi Hotlink & Anti-Bot
      const fetchHeaders = new Headers({
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": request.headers.get("Accept-Language") || "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": `${targetUrl.protocol}//${targetUrl.hostname}/`,
        "Origin": `${targetUrl.protocol}//${targetUrl.hostname}`,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-site",
      });

      const imgResponse = await fetch(imageUrl, {
        headers: fetchHeaders,
        redirect: "follow",
      });

      if (!imgResponse.ok) {
        return Response.redirect(imageUrl, 302);
      }

      const contentType = imgResponse.headers.get("content-type") || "";
      const originalBuffer = new Uint8Array(await imgResponse.arrayBuffer());
      const originalSize = originalBuffer.byteLength;

      // Lewati kompresi jika GIF, SVG, atau ukuran di bawah 10KB, maupun di atas 5MB (mencegah limit memori)
      if (
        contentType.includes("gif") ||
        contentType.includes("svg") ||
        originalSize < 10240 ||
        originalSize > 5242880
      ) {
        return new Response(originalBuffer, {
          status: 200,
          headers: {
            "Content-Type": contentType || "image/jpeg",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "public, max-age=604800, immutable",
          },
        });
      }

      // Proses kompresi di memori Worker menggunakan WebAssembly
      const inputImage = PhotonImage.new_from_byteslice(originalBuffer);

      if (isBw) {
        grayscale(inputImage);
      }

      const outputBuffer = isJpeg
        ? inputImage.get_bytes_jpeg(quality)
        : inputImage.get_bytes_webp();

      // Wajib membebaskan memori WASM setelah selesai
      inputImage.free();

      const compressedSize = outputBuffer.byteLength;
      const bytesSaved = originalSize > compressedSize ? originalSize - compressedSize : 0;

      const finalBuffer = compressedSize < originalSize ? outputBuffer : originalBuffer;
      const finalType = compressedSize < originalSize ? (isJpeg ? "image/jpeg" : "image/webp") : contentType;

      return new Response(finalBuffer, {
        status: 200,
        headers: {
          "Content-Type": finalType,
          "Content-Length": finalBuffer.byteLength.toString(),
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Original-Size": originalSize.toString(),
          "X-Bytes-Saved": bytesSaved.toString(),
        },
      });
    } catch (error) {
      return Response.redirect(imageUrl, 302);
    }
  },
};
