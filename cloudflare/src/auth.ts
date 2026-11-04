// Signed-cookie sessions, password hashing and kiosk links.
// The Flask server used Werkzeug (scrypt) and itsdangerous; Workers only have WebCrypto,
// so passwords are PBKDF2-SHA256 here (100k iterations is the Workers maximum).

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export function randomToken(bytes = 18): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secret, k);
  }
  return k;
}

async function sign(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
}

// --- passwords ---------------------------------------------------------------

const PBKDF2_ITER = 100_000;

async function pbkdf2(password: string, salt: string, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: iter }, key, 256);
  return hex(bits);
}

/** 'pbkdf2_sha256$100000$<salt>$<hex>' — also produced by scripts/set-password.mjs. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken(12);
  return `pbkdf2_sha256$${PBKDF2_ITER}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}

export async function checkPassword(stored: string, password: string): Promise<boolean> {
  const [algo, iter, salt, want] = stored.split("$");
  if (algo !== "pbkdf2_sha256" || !want) return false;
  return safeEqual(await pbkdf2(password, salt, Number(iter)), want);
}

// --- sessions ------------------------------------------------------------------

export type SessionData = {
  user?: string;
  uid?: number;
  view_org?: number;
  csrf?: string;
  exp?: number;
  flashes?: [string, string][];
  new_key?: { name: string; key: string };
};

const COOKIE = "session";
const LIFETIME = 7 * 86400;

export class Session {
  dirty = false;
  constructor(public data: SessionData, private secret: string) {}

  static async load(req: Request, secret: string): Promise<Session> {
    const raw = (req.headers.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
    if (raw) {
      const [payload, mac] = raw.slice(COOKIE.length + 1).split(".");
      if (payload && mac && safeEqual(mac, await sign(secret, "session:" + payload))) {
        try {
          const data = JSON.parse(new TextDecoder().decode(unb64url(payload))) as SessionData;
          if (!data.exp || data.exp > Date.now() / 1000) return new Session(data, secret);
        } catch { /* fall through */ }
      }
    }
    return new Session({}, secret);
  }

  get user() { return this.data.user; }

  set<K extends keyof SessionData>(k: K, v: SessionData[K]) {
    this.data[k] = v;
    this.dirty = true;
  }

  clear() {
    this.data = {};
    this.dirty = true;
  }

  csrfToken(): string {
    if (!this.data.csrf) this.set("csrf", randomToken(24));
    return this.data.csrf!;
  }

  flash(msg: string, cat = "ok") {
    this.set("flashes", [...(this.data.flashes || []), [cat, msg]]);
  }

  popFlashes(): [string, string][] {
    const f = this.data.flashes || [];
    if (f.length) this.set("flashes", []);
    return f;
  }

  popNewKey() {
    const k = this.data.new_key;
    if (k) this.set("new_key", undefined);
    return k;
  }

  async cookie(secure: boolean): Promise<string> {
    if (this.data.user) this.data.exp = Math.floor(Date.now() / 1000) + LIFETIME;
    const payload = b64url(enc.encode(JSON.stringify(this.data)));
    const value = `${payload}.${await sign(this.secret, "session:" + payload)}`;
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LIFETIME}${secure ? "; Secure" : ""}`;
  }
}

// --- kiosk links -----------------------------------------------------------------

async function keyTag(key: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(key))).slice(0, 12);
}

/** Login-free link to one door's live screen. Changing the door key revokes it. */
export async function kioskToken(secret: string, dev: { id: number; key: string }): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ d: dev.id, k: await keyTag(dev.key) })));
  return `${payload}.${await sign(secret, "kiosk:" + payload)}`;
}

/** Returns the door id if the token is valid for the door's current key (checked by caller). */
export async function kioskPayload(secret: string, token: string): Promise<{ d: number; k: string } | null> {
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !safeEqual(mac, await sign(secret, "kiosk:" + payload))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return null;
  }
}

export async function kioskMatches(payload: { k: string }, dev: Record<string, any>) {
  return payload.k === (await keyTag(dev.key));
}
