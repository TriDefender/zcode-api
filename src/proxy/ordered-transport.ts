import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

export type OrderedHeaderPair = [string, string];

export interface OrderedUpstreamRequest {
  url: string;
  method?: string;
  headers: OrderedHeaderPair[];
  body?: string | Uint8Array;
  decompress?: boolean;
}

type WireSocket = Socket | TLSSocket;

const CRLF = "\r\n";
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export async function sendOrderedUpstreamRequest(req: OrderedUpstreamRequest): Promise<Response> {
  const url = new URL(req.url);
  const bodyBytes = bodyToBytes(req.body);
  const requestHead = buildRequestHead(url, req.method ?? "POST", req.headers, bodyBytes.byteLength);
  const socket = await openSocket(url);

  return await new Promise<Response>((resolve, reject) => {
    let headerBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let responseStarted = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let chunkedDecoder: ChunkedDecoder | null = null;
    let remainingContentLength: number | null = null;

    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        socket.destroy();
      },
    });

    function fail(err: unknown): void {
      if (responseStarted) bodyController?.error(err);
      else reject(err);
      socket.destroy();
    }

    function finish(): void {
      if (chunkedDecoder && !chunkedDecoder.done) return;
      try { bodyController?.close(); } catch {}
    }

    function pushBody(bytes: Uint8Array): void {
      if (!bodyController || bytes.byteLength === 0) return;
      if (chunkedDecoder) {
        chunkedDecoder.push(bytes, bodyController);
        if (chunkedDecoder.done) finish();
        return;
      }
      if (remainingContentLength !== null) {
        const next = bytes.slice(0, remainingContentLength);
        remainingContentLength -= next.byteLength;
        if (next.byteLength > 0) bodyController.enqueue(next);
        if (remainingContentLength === 0) finish();
        return;
      }
      bodyController.enqueue(bytes);
    }

    socket.on("data", (chunk: Buffer) => {
      try {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (!responseStarted) {
          headerBuffer = concatBytes(headerBuffer, bytes);
          const headerEnd = indexOfBytes(headerBuffer, HEADER_END);
          if (headerEnd < 0) return;

          const headerBytes = headerBuffer.slice(0, headerEnd);
          const rest = headerBuffer.slice(headerEnd + HEADER_END.byteLength);
          const parsed = parseResponseHeaders(headerBytes);
          responseStarted = true;

          const transferEncoding = parsed.headers.get("transfer-encoding")?.toLowerCase() ?? "";
          if (transferEncoding.split(",").map((s) => s.trim()).includes("chunked")) {
            parsed.headers.delete("transfer-encoding");
            chunkedDecoder = new ChunkedDecoder();
          } else {
            const contentLength = parsed.headers.get("content-length");
            remainingContentLength = contentLength ? Number.parseInt(contentLength, 10) : null;
            if (!Number.isFinite(remainingContentLength as number)) remainingContentLength = null;
          }

          let responseBody: ReadableStream<Uint8Array> = bodyStream;
          if (req.decompress && parsed.headers.get("content-encoding")?.toLowerCase() === "gzip") {
            parsed.headers.delete("content-encoding");
            parsed.headers.delete("content-length");
            const gzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
            responseBody = bodyStream.pipeThrough(gzip);
          }

          resolve(new Response(responseBody, {
            status: parsed.status,
            statusText: parsed.statusText,
            headers: parsed.headers,
          }));
          pushBody(rest);
          return;
        }
        pushBody(bytes);
      } catch (err) {
        fail(err);
      }
    });

    socket.once("error", fail);
    socket.once("end", () => {
      if (!responseStarted) {
        reject(new Error("upstream closed before sending response headers"));
        return;
      }
      finish();
    });

    socket.write(requestHead);
    if (bodyBytes.byteLength > 0) socket.write(bodyBytes);
  });
}

function openSocket(url: URL): Promise<WireSocket> {
  const isHttps = url.protocol === "https:";
  if (!isHttps && url.protocol !== "http:") {
    return Promise.reject(new Error(`Unsupported upstream protocol: ${url.protocol}`));
  }
  const port = Number(url.port || (isHttps ? 443 : 80));

  return new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", reject);
      resolve(socket);
    };
    const socket: WireSocket = isHttps
      ? connectTls({ host: url.hostname, port, servername: url.hostname }, onConnect)
      : connectTcp({ host: url.hostname, port }, onConnect);
    socket.once("error", reject);
  });
}

function buildRequestHead(url: URL, method: string, headers: OrderedHeaderPair[], contentLength: number): string {
  const path = `${url.pathname || "/"}${url.search}`;
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    ...headers.map(headerLine),
    `Content-Length: ${contentLength}`,
    "Connection: close",
    "",
    "",
  ];
  return lines.join(CRLF);
}

function headerLine([name, value]: OrderedHeaderPair): string {
  if (!HEADER_NAME.test(name)) throw new Error(`Invalid upstream header name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`Invalid upstream header value for ${name}`);
  return `${name}: ${value}`;
}

function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body;
}

function parseResponseHeaders(bytes: Uint8Array): { status: number; statusText: string; headers: Headers } {
  const text = new TextDecoder("latin1").decode(bytes);
  const lines = text.split(CRLF);
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) throw new Error(`Invalid upstream status line: ${statusLine}`);

  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers.append(line.slice(0, idx), line.slice(idx + 1).trimStart());
  }

  return { status: Number(match[1]), statusText: match[2] ?? "", headers };
}

class ChunkedDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private expectedSize: number | null = null;
  done = false;

  push(bytes: Uint8Array, controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.done) return;
    this.buffer = concatBytes(this.buffer, bytes);

    while (!this.done) {
      if (this.expectedSize === null) {
        const lineEnd = indexOfCrlf(this.buffer);
        if (lineEnd < 0) return;
        const line = new TextDecoder("latin1").decode(this.buffer.slice(0, lineEnd));
        const sizeHex = line.split(";", 1)[0].trim();
        const size = Number.parseInt(sizeHex, 16);
        if (!Number.isFinite(size)) throw new Error(`Invalid chunk size: ${line}`);
        this.buffer = this.buffer.slice(lineEnd + 2);
        this.expectedSize = size;
        if (size === 0) {
          this.done = true;
          return;
        }
      }

      if (this.buffer.byteLength < this.expectedSize + 2) return;
      const chunk = this.buffer.slice(0, this.expectedSize);
      controller.enqueue(chunk);
      this.buffer = this.buffer.slice(this.expectedSize + 2);
      this.expectedSize = null;
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  if (a.byteLength > 0) out.set(a, 0);
  if (b.byteLength > 0) out.set(b, a.byteLength);
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfCrlf(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.byteLength - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}
