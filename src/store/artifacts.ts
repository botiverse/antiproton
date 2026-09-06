import { createHash, createHmac } from "node:crypto";

/** S3/R2 artifact store. Only the gateway holds these credentials; agents and
 *  the JS sandbox get an opaque `r2://` reference or a short-lived signed URL. */
export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

const SERVICE = "s3";
const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, m: string) => createHmac("sha256", k).update(m).digest();

export class R2Artifacts {
  #cfg: Required<R2Config>;
  #host: string;

  constructor(cfg: R2Config) {
    this.#cfg = { region: "auto", ...cfg };
    this.#host = new URL(cfg.endpoint).host;
  }

  #signingKey(datestamp: string): Buffer {
    let k: Buffer | string = `AWS4${this.#cfg.secretAccessKey}`;
    for (const part of [datestamp, this.#cfg.region, SERVICE, "aws4_request"]) k = hmac(k, part);
    return k as Buffer;
  }

  async #request(method: string, key: string, body?: Uint8Array, contentType?: string) {
    const now = new Date();
    const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const datestamp = amzdate.slice(0, 8);
    const path = `/${this.#cfg.bucket}/${key}`;
    const payloadHash = hex(Buffer.from(body ?? new Uint8Array()));

    const headers: Record<string, string> = {
      host: this.#host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzdate,
    };
    if (contentType) headers["content-type"] = contentType;

    const signed = Object.keys(headers).sort();
    const canonical = [
      method,
      path.split("/").map(encodeURIComponent).join("/"),
      "",
      signed.map((h) => `${h}:${headers[h]}\n`).join(""),
      signed.join(";"),
      payloadHash,
    ].join("\n");

    const scope = `${datestamp}/${this.#cfg.region}/${SERVICE}/aws4_request`;
    const sig = hmac(
      this.#signingKey(datestamp),
      ["AWS4-HMAC-SHA256", amzdate, scope, hex(canonical)].join("\n"),
    ).toString("hex");

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.#cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signed.join(";")}, Signature=${sig}`;

    const res = await fetch(this.#cfg.endpoint + path, { method, headers, body });
    if (!res.ok) throw new Error(`r2 ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async put(key: string, body: string | Uint8Array, contentType = "application/octet-stream") {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const res = await this.#request("PUT", key, bytes, contentType);
    return {
      ref: `r2://${this.#cfg.bucket}/${key}`,
      etag: res.headers.get("etag") ?? "",
      bytes: bytes.byteLength,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.#request("GET", key);
    return new Uint8Array(await res.arrayBuffer());
  }
}
