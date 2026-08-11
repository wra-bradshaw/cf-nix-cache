import { WorkflowEntrypoint, DurableObject, WorkerEntrypoint } from "cloudflare:workers";
function namedStub(namespace, name) {
  if (!namespace)
    throw new Error(`missing durable object namespace for ${name}`);
  return namespace.getByName(name);
}
function idStub(namespace, id) {
  if (!namespace) throw new Error("missing durable object namespace");
  return namespace.get(
    typeof id === "string" ? namespace.idFromString(id) : id
  );
}
function permits(grant, required) {
  return grant === "admin" || grant === required || grant === "push" && required === "pull";
}
function permitsCache(claims, cache2, required) {
  return claims.grants.some(
    (grant) => (grant.cache === cache2 || grant.cache === "*") && permits(grant.role, required)
  );
}
function canDelegate(parent, grants, expiresAt) {
  return expiresAt <= parent.exp && grants.length > 0 && grants.every(
    (child) => parent.grants.some(
      (grant) => grant.role === "admin" && (grant.cache === "*" || grant.cache === child.cache)
    )
  );
}
function permitsAny(claims, required) {
  return claims.grants.some((grant) => permits(grant.role, required));
}
function permitsGlobal(claims, required) {
  return claims.grants.some(
    (grant) => grant.cache === "*" && permits(grant.role, required)
  );
}
const encoder$2 = new TextEncoder();
const decoder$1 = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}
function encode$1(string) {
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127) {
      throw new TypeError("non-ASCII string encountered in encode()");
    }
    bytes[i] = code;
  }
  return bytes;
}
const unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage)) {
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
  }
}
function checkModulusLength(alg, key) {
  const { modulusLength } = key.algorithm;
  if (typeof modulusLength !== "number" || modulusLength < 2048) {
    throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
  }
}
function checkCryptoKey(key, expected, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== expected.name) {
    throw unusable(expected.name);
  }
  if (expected.hash && algorithm.hash?.name !== expected.hash) {
    throw unusable(expected.hash, "algorithm.hash");
  }
  if (expected.namedCurve && algorithm.namedCurve !== expected.namedCurve) {
    throw unusable(expected.namedCurve, "algorithm.namedCurve");
  }
  if (expected.length !== void 0 && algorithm.length !== expected.length) {
    throw unusable(expected.length, "algorithm.length");
  }
  checkUsage(key, usage);
}
function message(msg, actual, ...types) {
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else if (types.length === 2) {
    msg += `one of type ${types[0]} or ${types[1]}.`;
  } else {
    msg += `of type ${types[0]}.`;
  }
  if (actual == null) {
    msg += ` Received ${actual}`;
  } else if (typeof actual === "function" && actual.name) {
    msg += ` Received function ${actual.name}`;
  } else if (typeof actual === "object" && actual != null) {
    if (actual.constructor?.name) {
      msg += ` Received an instance of ${actual.constructor.name}`;
    }
  }
  return msg;
}
const withAlg = (alg, actual, ...types) => message(`Key for the ${alg} algorithm must be `, actual, ...types);
class JOSEError extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
class JWTClaimValidationFailed extends JOSEError {
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } });
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
}
class JWTExpired extends JOSEError {
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } });
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
}
class JOSEAlgNotAllowed extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
}
class JOSENotSupported extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
}
class JWSInvalid extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
}
class JWTInvalid extends JOSEError {
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
}
class JWKSInvalid extends JOSEError {
  static code = "ERR_JWKS_INVALID";
  code = "ERR_JWKS_INVALID";
}
class JWKSNoMatchingKey extends JOSEError {
  static code = "ERR_JWKS_NO_MATCHING_KEY";
  code = "ERR_JWKS_NO_MATCHING_KEY";
  constructor(message2 = "no applicable key found in the JSON Web Key Set", options) {
    super(message2, options);
  }
}
class JWKSMultipleMatchingKeys extends JOSEError {
  [Symbol.asyncIterator] = async function* () {
  };
  static code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  constructor(message2 = "multiple matching keys found in the JSON Web Key Set", options) {
    super(message2, options);
  }
}
class JWSSignatureVerificationFailed extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
}
const isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
const isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
const isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);
function encodeBase64(input) {
  if (Uint8Array.prototype.toBase64) {
    return input.toBase64();
  }
  const CHUNK_SIZE = 32768;
  const arr = [];
  for (let i = 0; i < input.length; i += CHUNK_SIZE) {
    arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(arr.join(""));
}
function decodeBase64(encoded) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(encoded);
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
const invalid = "The input to be decoded is not correctly encoded.";
function decode(input) {
  if (Uint8Array.fromBase64) {
    try {
      return Uint8Array.fromBase64(typeof input === "string" ? input : decoder$1.decode(input), {
        alphabet: "base64url"
      });
    } catch (cause) {
      throw new TypeError(invalid, { cause });
    }
  }
  let encoded = input;
  if (encoded instanceof Uint8Array) {
    encoded = decoder$1.decode(encoded);
  }
  if (encoded.includes("+") || encoded.includes("/")) {
    throw new TypeError(invalid);
  }
  encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeBase64(encoded);
  } catch {
    throw new TypeError(invalid);
  }
}
function encode(input) {
  let unencoded = input;
  if (typeof unencoded === "string") {
    unencoded = encoder$2.encode(unencoded);
  }
  if (Uint8Array.prototype.toBase64) {
    return unencoded.toBase64({ alphabet: "base64url", omitPadding: true });
  }
  return encodeBase64(unencoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function isObject(input) {
  if (typeof input !== "object" || input === null || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype === null) {
    return true;
  }
  let proto = prototype;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return prototype === proto;
}
function isDisjoint(...headers) {
  const parameters = /* @__PURE__ */ new Set();
  for (const header of headers) {
    if (!header)
      continue;
    for (const parameter of Object.keys(header)) {
      if (parameters.has(parameter)) {
        return false;
      }
      parameters.add(parameter);
    }
  }
  return true;
}
const isJWK = (key) => isObject(key) && typeof key.kty === "string";
const isPrivateJWK = (key) => key.kty !== "oct" && (key.kty === "AKP" && typeof key.priv === "string" || typeof key.d === "string");
const isPublicJWK = (key) => key.kty !== "oct" && key.d === void 0 && key.priv === void 0;
const isSecretJWK = (key) => key.kty === "oct" && typeof key.k === "string";
function assertNotSet(value, name) {
  if (value) {
    throw new TypeError(`${name} can only be called once`);
  }
}
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}
function encodeBase64url(value, label, ErrorClass) {
  try {
    return encode$1(value);
  } catch {
    throw new ErrorClass(`The ${label} is not a valid base64url string`);
  }
}
function parseJoseHeader(b64, ErrorClass, message2) {
  let parsed;
  try {
    parsed = JSON.parse(strictDecoder.decode(decode(b64)));
  } catch {
    throw new ErrorClass(message2);
  }
  if (!isObject(parsed)) {
    throw new ErrorClass(message2);
  }
  return parsed;
}
async function jwkToKey(entry, jwk) {
  if (jwk.kty === "RSA" && "oth" in jwk && jwk.oth !== void 0) {
    throw new JOSENotSupported('RSA JWK "oth" (Other Primes Info) Parameter value is not supported');
  }
  if (!entry.kty.includes(jwk.kty)) {
    throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
  }
  const algorithm = entry.resolve?.({ kty: jwk.kty, crv: jwk.crv }) ?? entry.subtle;
  const isPrivate = !!(jwk.d || jwk.priv);
  const keyData = { ...jwk };
  if (keyData.kty !== "AKP") {
    delete keyData.alg;
  }
  delete keyData.use;
  return crypto.subtle.importKey("jwk", keyData, algorithm, jwk.ext ?? !isPrivate, jwk.key_ops ?? entry.usages[isPrivate ? 1 : 0]);
}
const tag = (key) => key[Symbol.toStringTag];
const jwkMatchesOp = (entry, key, usage) => {
  const { alg } = entry;
  if (key.use !== void 0) {
    const expected = usage === "sign" || usage === "verify" ? "sig" : "enc";
    if (key.use !== expected) {
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
    }
  }
  if (key.alg !== void 0 && key.alg !== alg) {
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  }
  if (Array.isArray(key.key_ops)) {
    const expectedKeyOp = usage === "encrypt" || usage === "decrypt" ? entry.ops?.[usage === "encrypt" ? 0 : 1] : usage;
    if (expectedKeyOp && !key.key_ops.includes(expectedKeyOp)) {
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
    }
  }
};
function checkKeyType(entry, key, usage) {
  const { alg, secret } = entry;
  const privateKey = usage === "decrypt" || usage === "sign";
  if (secret && key instanceof Uint8Array)
    return [BYTES, key];
  if (isJWK(key)) {
    if (secret ? !isSecretJWK(key) : !(privateKey ? isPrivateJWK(key) : isPublicJWK(key))) {
      throw new TypeError(secret ? `JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present` : `JSON Web Key for this operation must be a ${privateKey ? "private" : "public"} JWK`);
    }
    jwkMatchesOp(entry, key, usage);
    return [JWK, key];
  }
  if (!isKeyLike(key)) {
    throw new TypeError(secret ? withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key", "Uint8Array") : withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key"));
  }
  if (secret) {
    if (key.type !== "secret") {
      throw new TypeError(`${tag(key)} instances for symmetric algorithms must be of type "secret"`);
    }
  } else {
    if (key.type === "secret") {
      throw new TypeError(`${tag(key)} instances for asymmetric algorithms must not be of type "secret"`);
    }
    const expectedType = privateKey ? "private" : "public";
    if ((key.type === "public" || key.type === "private") && key.type !== expectedType) {
      const operation = usage === "sign" ? "signing" : usage === "verify" ? "verifying" : `${usage.slice(0, -1)}tion`;
      throw new TypeError(`${tag(key)} instances for asymmetric algorithm ${operation} must be of type "${expectedType}"`);
    }
  }
  return isCryptoKey(key) ? [CRYPTO, key] : [KEYOBJECT, key];
}
const BYTES = 0;
const CRYPTO = 1;
const KEYOBJECT = 2;
const JWK = 3;
let cache;
const nist = {
  __proto__: null,
  prime256v1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521"
};
function cached(key, alg, value) {
  cache ||= /* @__PURE__ */ new WeakMap();
  const entry = cache.get(key);
  if (value) {
    if (entry) {
      entry[alg] = value;
    } else {
      cache.set(key, { __proto__: null, [alg]: value });
    }
  }
  return value ?? entry?.[alg];
}
const handleJWK = async (key, jwk, entry) => cached(key, entry.alg) ?? cached(key, entry.alg, await jwkToKey(entry, { ...jwk, alg: entry.alg }));
const handleKeyObject = (keyObject, entry) => {
  const hit = cached(keyObject, entry.alg);
  if (hit)
    return hit;
  const isPublic = keyObject.type === "public";
  const usages = entry.usages[isPublic ? 0 : 1];
  const { asymmetricKeyType } = keyObject;
  const crv = nist[keyObject.asymmetricKeyDetails?.namedCurve];
  const params = entry.resolve?.({ crv, asymmetricKeyType }) ?? entry.subtle;
  return cached(keyObject, entry.alg, keyObject.toCryptoKey(params, isPublic, usages));
};
async function prepareKey(entry, key, usage) {
  const tagged = checkKeyType(entry, key, usage);
  switch (tagged[0]) {
    case BYTES:
    case CRYPTO:
      return tagged[1];
    case JWK: {
      const key2 = tagged[1];
      if (key2.k) {
        return decode(key2.k);
      }
      if (!Object.isFrozen(key2)) {
        const { key_ops } = key2;
        if (Array.isArray(key_ops))
          Object.freeze(key_ops);
        Object.freeze(key2);
      }
      return handleJWK(key2, key2, entry);
    }
    case KEYOBJECT: {
      const keyObject = tagged[1];
      if (keyObject.type === "secret") {
        return keyObject.export();
      }
      if ("toCryptoKey" in keyObject && typeof keyObject.toCryptoKey === "function") {
        return handleKeyObject(keyObject, entry);
      }
      return handleJWK(keyObject, keyObject.export({ format: "jwk" }), entry);
    }
  }
}
function table(entries) {
  const out = { __proto__: null };
  for (const alg in entries) {
    out[alg] = { ...entries[alg], alg };
  }
  return out;
}
const wrap = [
  ["encrypt", "wrapKey"],
  ["decrypt", "unwrapKey"]
];
const derive = [[], ["deriveBits"]];
const none = [[], []];
function rsaes(bits) {
  return {
    kty: ["RSA"],
    subtle: { name: "RSA-OAEP", hash: `SHA-${bits}` },
    usages: wrap,
    ops: ["wrapKey", "unwrapKey"]
  };
}
function ecdh() {
  return {
    kty: ["EC", "OKP"],
    subtle: { name: "ECDH" },
    resolve: ({ kty, crv, asymmetricKeyType }) => {
      if (crv === "X25519" || asymmetricKeyType === "x25519") {
        return { name: "X25519" };
      }
      if (kty === "OKP") {
        throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      return { name: "ECDH", namedCurve: crv };
    },
    usages: derive,
    ops: [void 0, "deriveBits"]
  };
}
function aeskw(bits, gcm = false) {
  return {
    kty: ["oct"],
    secret: true,
    subtle: { name: gcm ? "AES-GCM" : "AES-KW", length: bits },
    usages: none,
    ops: gcm ? ["encrypt", "decrypt"] : ["wrapKey", "unwrapKey"]
  };
}
function pbes2() {
  return {
    kty: ["oct"],
    secret: true,
    subtle: { name: "PBKDF2" },
    usages: none,
    ops: ["deriveBits", "deriveBits"]
  };
}
const JWE = table({
  dir: {
    kty: ["oct"],
    secret: true,
    subtle: { name: "AES-GCM" },
    usages: none,
    ops: ["encrypt", "decrypt"]
  },
  "RSA-OAEP": rsaes(1),
  "RSA-OAEP-256": rsaes(256),
  "RSA-OAEP-384": rsaes(384),
  "RSA-OAEP-512": rsaes(512),
  "ECDH-ES": ecdh(),
  "ECDH-ES+A128KW": ecdh(),
  "ECDH-ES+A192KW": ecdh(),
  "ECDH-ES+A256KW": ecdh(),
  A128KW: aeskw(128),
  A192KW: aeskw(192),
  A256KW: aeskw(256),
  A128GCMKW: aeskw(128, true),
  A192GCMKW: aeskw(192, true),
  A256GCMKW: aeskw(256, true),
  "PBES2-HS256+A128KW": pbes2(),
  "PBES2-HS384+A192KW": pbes2(),
  "PBES2-HS512+A256KW": pbes2()
});
const contentOps = ["encrypt", "decrypt"];
function contentEncryption(bits, cbc = false) {
  return {
    kty: ["oct"],
    secret: true,
    subtle: { name: cbc ? "AES-CBC" : "AES-GCM", length: bits },
    usages: none,
    ops: contentOps,
    cekBits: bits,
    ivBits: cbc ? 128 : 96,
    cbc
  };
}
table({
  A128GCM: contentEncryption(128),
  A192GCM: contentEncryption(192),
  A256GCM: contentEncryption(256),
  "A128CBC-HS256": contentEncryption(256, true),
  "A192CBC-HS384": contentEncryption(384, true),
  "A256CBC-HS512": contentEncryption(512, true)
});
const JWS_RECOGNIZED = { __proto__: null, b64: true };
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s !== "string"))) {
    throw new TypeError(`"${option}" option must be an array of strings`);
  }
  if (!algorithms) {
    return void 0;
  }
  return new Set(algorithms);
}
function validateCritDuplicates(Err, protectedHeader) {
  const { crit } = protectedHeader ?? {};
  if (Array.isArray(crit) && new Set(crit).size !== crit.length) {
    throw new Err('"crit" (Critical) Header Parameter MUST NOT contain duplicate values');
  }
}
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0) {
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  }
  if (!protectedHeader || protectedHeader.crit === void 0) {
    return [];
  }
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) {
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  }
  const recognized = recognizedOption === void 0 ? recognizedDefault : { __proto__: null, ...recognizedOption, ...recognizedDefault };
  for (const parameter of protectedHeader.crit) {
    if (!(parameter in recognized)) {
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    }
    if (!Object.hasOwn(joseHeader, parameter) || joseHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    }
    if (recognized[parameter] && (!Object.hasOwn(protectedHeader, parameter) || protectedHeader[parameter] === void 0)) {
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
    }
  }
  return protectedHeader.crit;
}
async function getSigKey(entry, key, usage) {
  if (key instanceof Uint8Array) {
    return crypto.subtle.importKey("raw", key, entry.subtle, false, [
      usage
    ]);
  }
  checkCryptoKey(key, entry.subtle, usage);
  if (entry.minRsaBits)
    checkModulusLength(entry.alg, key);
  return key;
}
async function sign(entry, key, data) {
  const cryptoKey = await getSigKey(entry, key, "sign");
  const signature = await crypto.subtle.sign(entry.signing, cryptoKey, data);
  return new Uint8Array(signature);
}
async function verify(entry, key, signature, data) {
  const cryptoKey = await getSigKey(entry, key, "verify");
  try {
    return await crypto.subtle.verify(entry.signing, cryptoKey, signature, data);
  } catch {
    return false;
  }
}
const sig = [["verify"], ["sign"]];
function hmac(bits) {
  const subtle = { name: "HMAC", hash: `SHA-${bits}` };
  return { kty: ["oct"], secret: true, subtle, signing: subtle, usages: sig };
}
function rsa(bits, saltLength) {
  const name = saltLength ? "RSA-PSS" : "RSASSA-PKCS1-v1_5";
  const subtle = { name, hash: `SHA-${bits}` };
  return {
    kty: ["RSA"],
    subtle,
    signing: saltLength ? { ...subtle, saltLength } : subtle,
    usages: sig,
    minRsaBits: 2048
  };
}
function ecdsa(crv, bits) {
  return {
    kty: ["EC"],
    crv,
    subtle: { name: "ECDSA", namedCurve: crv },
    signing: { name: "ECDSA", hash: `SHA-${bits}` },
    usages: sig
  };
}
function eddsa() {
  const subtle = { name: "Ed25519" };
  return {
    kty: ["OKP"],
    crv: "Ed25519",
    subtle,
    signing: subtle,
    usages: sig
  };
}
function mldsa(bits) {
  const name = `ML-DSA-${bits}`;
  const subtle = { name };
  return {
    kty: ["AKP"],
    subtle,
    signing: subtle,
    usages: sig
  };
}
const JWS = table({
  HS256: hmac(256),
  HS384: hmac(384),
  HS512: hmac(512),
  RS256: rsa(256),
  RS384: rsa(384),
  RS512: rsa(512),
  PS256: rsa(256, 32),
  PS384: rsa(384, 48),
  PS512: rsa(512, 64),
  ES256: ecdsa("P-256", 256),
  ES384: ecdsa("P-384", 384),
  ES512: ecdsa("P-521", 512),
  EdDSA: eddsa(),
  Ed25519: eddsa(),
  "ML-DSA-44": mldsa(44),
  "ML-DSA-65": mldsa(65),
  "ML-DSA-87": mldsa(87)
});
function jwsAlgorithm(alg) {
  const entry = typeof alg === "string" ? JWS[alg] : void 0;
  if (!entry) {
    throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
  return entry;
}
function prepareVerify(options) {
  return [options && validateAlgorithms("algorithms", options.algorithms), options?.crit];
}
async function verifySignature$1(jws, shared, key) {
  const { protected: encodedProtected, header, payload: inputPayload } = jws;
  let parsedProt = {};
  if (encodedProtected) {
    parsedProt = parseJoseHeader(encodedProtected, JWSInvalid, "JWS Protected Header is invalid");
  }
  let joseHeader;
  if (header !== void 0) {
    if (!isDisjoint(parsedProt, header)) {
      throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
    }
    joseHeader = { ...parsedProt, ...header };
  } else {
    joseHeader = parsedProt;
  }
  const extensions = validateCrit(JWSInvalid, JWS_RECOGNIZED, shared[1], parsedProt, joseHeader);
  let b64 = true;
  if (extensions.includes("b64")) {
    b64 = parsedProt.b64;
    if (typeof b64 !== "boolean") {
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    }
  }
  const { alg } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  }
  if (shared[0] && !shared[0].has(alg)) {
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  }
  if (b64) {
    if (typeof inputPayload !== "string") {
      throw new JWSInvalid("JWS Payload must be a string");
    }
  } else if (typeof inputPayload !== "string" && !(inputPayload instanceof Uint8Array)) {
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  }
  let resolvedKey = false;
  if (typeof key === "function") {
    key = await key(parsedProt, jws);
    resolvedKey = true;
  }
  const entry = jwsAlgorithm(alg);
  const data = concat(encodedProtected !== void 0 ? encode$1(encodedProtected) : new Uint8Array(), encode$1("."), typeof inputPayload === "string" ? b64 ? shared[2] ??= encodeBase64url(inputPayload, "payload", JWSInvalid) : encoder$2.encode(inputPayload) : inputPayload);
  const signature = decodeBase64url(jws.signature, "signature", JWSInvalid);
  const k = await prepareKey(entry, key, "verify");
  const verified = await verify(entry, k, signature, data);
  if (!verified) {
    throw new JWSSignatureVerificationFailed();
  }
  let payload;
  if (b64) {
    payload = decodeBase64url(inputPayload, "payload", JWSInvalid);
  } else if (typeof inputPayload === "string") {
    payload = encoder$2.encode(inputPayload);
  } else {
    payload = inputPayload;
  }
  return [payload, parsedProt, b64, k, resolvedKey];
}
async function verifyCompact(jws, shared, key) {
  if (jws instanceof Uint8Array) {
    jws = decoder$1.decode(jws);
  }
  if (typeof jws !== "string") {
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  }
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3) {
    throw new JWSInvalid("Invalid Compact JWS");
  }
  return verifySignature$1({ payload, protected: protectedHeader, signature }, shared, key);
}
const epoch = (date) => Math.floor(date.getTime() / 1e3);
const multipliers = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31557600
};
const REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
const checkFailed = "check_failed";
function secs(str) {
  const matched = REGEX.exec(str);
  if (!matched || matched[4] && matched[1]) {
    throw new TypeError("Invalid time period format");
  }
  const value = parseFloat(matched[2]);
  const numericDate2 = Math.round(value * multipliers[matched[3][0].toLowerCase()]);
  if (matched[1] === "-" || matched[4] === "ago") {
    return -numericDate2;
  }
  return numericDate2;
}
function validateInput(label, input) {
  if (!Number.isFinite(input)) {
    throw new TypeError(`Invalid ${label} input`);
  }
  return input;
}
function numericDate(value, label) {
  if (typeof value === "number")
    return validateInput(label, value);
  if (value instanceof Date)
    return validateInput(label, epoch(value));
  return epoch(/* @__PURE__ */ new Date()) + secs(value);
}
const normalizeTyp = (value) => {
  if (value.includes("/")) {
    return value.toLowerCase();
  }
  return `application/${value.toLowerCase()}`;
};
const checkAudiencePresence = (audPayload, audOption) => {
  if (typeof audPayload === "string") {
    return audOption.includes(audPayload);
  }
  if (Array.isArray(audPayload)) {
    return audOption.some((aud) => audPayload.includes(aud));
  }
  return false;
};
function validateNumericDate(payload, claim, required = false) {
  const value = payload[claim];
  if (value === void 0 && !required)
    return void 0;
  if (typeof value !== "number") {
    throw new JWTClaimValidationFailed(`"${claim}" claim must be a number`, payload, claim, "invalid");
  }
  return value;
}
function unexpectedClaim(payload, claim) {
  throw new JWTClaimValidationFailed(`unexpected "${claim}" claim value`, payload, claim, checkFailed);
}
function validateClaimsSet(protectedHeader, encodedPayload, options = {}) {
  let payload;
  try {
    payload = JSON.parse(strictDecoder.decode(encodedPayload));
  } catch {
  }
  if (!isObject(payload)) {
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
  }
  const { typ } = options;
  if (typ && (typeof protectedHeader.typ !== "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ))) {
    throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', payload, "typ", checkFailed);
  }
  const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options;
  const presenceCheck = [...requiredClaims];
  if (maxTokenAge !== void 0)
    presenceCheck.push("iat");
  if (audience !== void 0)
    presenceCheck.push("aud");
  if (subject !== void 0)
    presenceCheck.push("sub");
  if (issuer !== void 0)
    presenceCheck.push("iss");
  for (const claim of new Set(presenceCheck.reverse())) {
    if (!Object.hasOwn(payload, claim)) {
      throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, payload, claim, "missing");
    }
  }
  if (issuer !== void 0 && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss)) {
    unexpectedClaim(payload, "iss");
  }
  if (subject !== void 0 && payload.sub !== subject) {
    unexpectedClaim(payload, "sub");
  }
  if (audience !== void 0 && !checkAudiencePresence(payload.aud, typeof audience === "string" ? [audience] : audience)) {
    unexpectedClaim(payload, "aud");
  }
  const { clockTolerance } = options;
  let tolerance = 0;
  if (typeof clockTolerance === "string") {
    tolerance = secs(clockTolerance);
  } else if (clockTolerance !== void 0) {
    if (typeof clockTolerance !== "number") {
      throw new TypeError("Invalid clockTolerance option type");
    }
    tolerance = clockTolerance;
  }
  validateInput("clockTolerance option", tolerance);
  const { currentDate } = options;
  const now2 = validateInput("currentDate option", epoch(currentDate || /* @__PURE__ */ new Date()));
  const iat = validateNumericDate(payload, "iat", maxTokenAge !== void 0);
  const nbf = validateNumericDate(payload, "nbf");
  if (nbf !== void 0) {
    if (nbf > now2 + tolerance) {
      throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', payload, "nbf", checkFailed);
    }
  }
  const exp = validateNumericDate(payload, "exp");
  if (exp !== void 0) {
    if (exp <= now2 - tolerance) {
      throw new JWTExpired('"exp" claim timestamp check failed', payload, "exp", checkFailed);
    }
  }
  if (maxTokenAge !== void 0) {
    const age = now2 - iat;
    const max = typeof maxTokenAge === "number" ? maxTokenAge : secs(maxTokenAge);
    if (age - tolerance > max) {
      throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', payload, "iat", checkFailed);
    }
    if (age < 0 - tolerance) {
      throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", checkFailed);
    }
  }
  return payload;
}
class JWTClaimsBuilder {
  #payload;
  constructor(payload) {
    if (!isObject(payload)) {
      throw new TypeError("JWT Claims Set MUST be an object");
    }
    this.#payload = structuredClone(payload);
  }
  data() {
    return encoder$2.encode(JSON.stringify(this.#payload));
  }
  get iss() {
    return this.#payload.iss;
  }
  set iss(value) {
    this.#payload.iss = value;
  }
  get sub() {
    return this.#payload.sub;
  }
  set sub(value) {
    this.#payload.sub = value;
  }
  get aud() {
    return this.#payload.aud;
  }
  set aud(value) {
    this.#payload.aud = value;
  }
  set jti(value) {
    this.#payload.jti = value;
  }
  set nbf(value) {
    this.#payload.nbf = numericDate(value, "setNotBefore");
  }
  set exp(value) {
    this.#payload.exp = numericDate(value, "setExpirationTime");
  }
  set iat(value) {
    if (value === void 0) {
      this.#payload.iat = epoch(/* @__PURE__ */ new Date());
    } else if (typeof value === "string") {
      this.#payload.iat = validateInput("setIssuedAt", epoch(/* @__PURE__ */ new Date()) + secs(value));
    } else {
      this.#payload.iat = numericDate(value, "setIssuedAt");
    }
  }
}
async function jwtVerify(jwt, key, options) {
  const verified = await verifyCompact(jwt, prepareVerify(options), key);
  if (!verified[2]) {
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  }
  const payload = validateClaimsSet(verified[1], verified[0], options);
  const result = { payload, protectedHeader: verified[1] };
  if (typeof key === "function") {
    return { ...result, key: verified[3] };
  }
  return result;
}
function unencodedPayload(protectedHeader) {
  return protectedHeader?.b64 === false && Array.isArray(protectedHeader.crit) && protectedHeader.crit.includes("b64");
}
async function createSignature(input, key) {
  const { protectedHeader, unprotectedHeader } = input;
  if (!protectedHeader && !unprotectedHeader) {
    throw new JWSInvalid("either setProtectedHeader or setUnprotectedHeader must be called before #sign()");
  }
  if (!isDisjoint(protectedHeader, unprotectedHeader)) {
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  }
  const joseHeader = { ...protectedHeader, ...unprotectedHeader };
  validateCritDuplicates(JWSInvalid, protectedHeader);
  const extensions = validateCrit(JWSInvalid, JWS_RECOGNIZED, input.crit, protectedHeader, joseHeader);
  let b64 = true;
  if (extensions.includes("b64")) {
    b64 = protectedHeader.b64;
    if (typeof b64 !== "boolean") {
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    }
  }
  const { alg } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  }
  const entry = jwsAlgorithm(alg);
  let payloadS;
  let payloadB;
  if (b64) {
    const encoded = input.encoded ??= [];
    encoded[0] ??= encode(input.payload);
    encoded[1] ??= encode$1(encoded[0]);
    payloadS = encoded[0];
    payloadB = encoded[1];
  } else {
    payloadB = input.payload;
    payloadS = "";
  }
  let protectedHeaderString;
  let protectedHeaderBytes;
  if (protectedHeader) {
    protectedHeaderString = encode(JSON.stringify(protectedHeader));
    protectedHeaderBytes = encode$1(protectedHeaderString);
  } else {
    protectedHeaderString = "";
    protectedHeaderBytes = new Uint8Array();
  }
  const data = concat(protectedHeaderBytes, encode$1("."), payloadB);
  const k = await prepareKey(entry, key, "sign");
  const signature = await sign(entry, k, data);
  const jws = {
    signature: encode(signature),
    payload: payloadS
  };
  if (protectedHeader) {
    jws.protected = protectedHeaderString;
  }
  if (unprotectedHeader) {
    jws.header = unprotectedHeader;
  }
  return jws;
}
class FlattenedSign {
  #payload;
  #protectedHeader;
  #unprotectedHeader;
  constructor(payload) {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("payload must be an instance of Uint8Array");
    }
    this.#payload = payload;
  }
  setProtectedHeader(protectedHeader) {
    assertNotSet(this.#protectedHeader, "setProtectedHeader");
    this.#protectedHeader = protectedHeader;
    return this;
  }
  setUnprotectedHeader(unprotectedHeader) {
    assertNotSet(this.#unprotectedHeader, "setUnprotectedHeader");
    this.#unprotectedHeader = unprotectedHeader;
    return this;
  }
  async sign(key, options) {
    return createSignature({
      payload: this.#payload,
      protectedHeader: this.#protectedHeader,
      unprotectedHeader: this.#unprotectedHeader,
      crit: options?.crit
    }, key);
  }
}
class CompactSign {
  #flattened;
  #protectedHeader;
  constructor(payload) {
    this.#flattened = new FlattenedSign(payload);
  }
  setProtectedHeader(protectedHeader) {
    this.#flattened.setProtectedHeader(protectedHeader);
    this.#protectedHeader = protectedHeader;
    return this;
  }
  async sign(key, options) {
    if (unencodedPayload(this.#protectedHeader)) {
      throw new TypeError("use the flattened module for creating JWS with b64: false");
    }
    const jws = await this.#flattened.sign(key, options);
    return `${jws.protected}.${jws.payload}.${jws.signature}`;
  }
}
class SignJWT {
  #protectedHeader;
  #jwt;
  constructor(payload = {}) {
    this.#jwt = new JWTClaimsBuilder(payload);
  }
  setIssuer(issuer) {
    this.#jwt.iss = issuer;
    return this;
  }
  setSubject(subject) {
    this.#jwt.sub = subject;
    return this;
  }
  setAudience(audience) {
    this.#jwt.aud = audience;
    return this;
  }
  setJti(jwtId) {
    this.#jwt.jti = jwtId;
    return this;
  }
  setNotBefore(input) {
    this.#jwt.nbf = input;
    return this;
  }
  setExpirationTime(input) {
    this.#jwt.exp = input;
    return this;
  }
  setIssuedAt(input) {
    this.#jwt.iat = input;
    return this;
  }
  setProtectedHeader(protectedHeader) {
    this.#protectedHeader = protectedHeader;
    return this;
  }
  async sign(key, options) {
    const sig2 = new CompactSign(this.#jwt.data());
    sig2.setProtectedHeader(this.#protectedHeader);
    if (unencodedPayload(this.#protectedHeader)) {
      throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
    }
    return sig2.sign(key, options);
  }
}
function unsupportedAlg(source = 'JWK "alg" (Algorithm) Parameter') {
  throw new JOSENotSupported(`Invalid or unsupported ${source} value`);
}
function keyAlgorithm(alg, source) {
  return (typeof alg === "string" ? JWS[alg] ?? JWE[alg] : void 0) ?? unsupportedAlg(source);
}
function signatureAlgorithm(alg) {
  const entry = typeof alg === "string" ? JWS[alg] : void 0;
  if (!entry || entry.secret) {
    throw new JOSENotSupported('Unsupported "alg" value for a JSON Web Key Set');
  }
  return entry;
}
function isJWKSLike(jwks) {
  if (!jwks || typeof jwks !== "object") {
    return false;
  }
  const { keys } = jwks;
  return Array.isArray(keys) && keys.every(isObject);
}
class LocalJWKSetImpl {
  #jwks;
  #cached = /* @__PURE__ */ new WeakMap();
  constructor(jwks) {
    if (!isJWKSLike(jwks)) {
      throw new JWKSInvalid("JSON Web Key Set malformed");
    }
    this.#jwks = structuredClone(jwks);
  }
  jwks() {
    return this.#jwks;
  }
  async getKey(protectedHeader, token) {
    const { alg, kid } = { ...protectedHeader, ...token?.header };
    const entry = signatureAlgorithm(alg);
    const candidates = this.#jwks.keys.filter((jwk2) => entry.kty.includes(jwk2.kty) && (typeof kid !== "string" || kid === jwk2.kid) && (!(typeof jwk2.alg === "string" || jwk2.kty === "AKP") || alg === jwk2.alg) && (typeof jwk2.use !== "string" || jwk2.use === "sig") && (!Array.isArray(jwk2.key_ops) || jwk2.key_ops.includes("verify")) && (!entry.crv || jwk2.crv === entry.crv));
    const { 0: jwk, length } = candidates;
    if (length === 0) {
      throw new JWKSNoMatchingKey();
    }
    if (length !== 1) {
      const error = new JWKSMultipleMatchingKeys();
      const _cached = this.#cached;
      error[Symbol.asyncIterator] = async function* () {
        for (const jwk2 of candidates) {
          try {
            yield await importWithAlgCache(_cached, jwk2, entry);
          } catch {
          }
        }
      };
      throw error;
    }
    return importWithAlgCache(this.#cached, jwk, entry);
  }
}
async function importWithAlgCache(cache2, jwk, entry) {
  const cached2 = cache2.get(jwk) || cache2.set(jwk, { __proto__: null }).get(jwk);
  if (cached2[entry.alg] === void 0) {
    const key = await jwkToKey(entry, { ...jwk, alg: entry.alg, ext: true });
    if (key.type !== "public") {
      throw new JWKSInvalid("JSON Web Key Set members must be public keys");
    }
    cached2[entry.alg] = key;
  }
  return cached2[entry.alg];
}
function createLocalJWKSet(jwks) {
  const set = new LocalJWKSetImpl(jwks);
  const localJWKSet = async (protectedHeader, token) => set.getKey(protectedHeader, token);
  Object.defineProperty(localJWKSet, "jwks", {
    value: () => structuredClone(set.jwks())
  });
  return localJWKSet;
}
async function importJWK(jwk, alg, options) {
  if (!isObject(jwk)) {
    throw new TypeError("JWK must be an object");
  }
  alg ??= jwk.alg;
  const ext = jwk.ext;
  if (jwk.kty !== "oct" && !alg) {
    throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
  }
  switch (jwk.kty) {
    case "oct":
      if (typeof jwk.k !== "string" || !jwk.k) {
        throw new TypeError('missing "k" (Key Value) Parameter value');
      }
      return decode(jwk.k);
    case "RSA":
      return jwkToKey(keyAlgorithm(alg), { ...jwk, alg, ext });
    case "AKP": {
      if (typeof jwk.alg !== "string" || !jwk.alg) {
        throw new TypeError('missing "alg" (Algorithm) Parameter value');
      }
      if (alg !== void 0 && alg !== jwk.alg) {
        throw new TypeError("JWK alg and alg option value mismatch");
      }
      return jwkToKey(keyAlgorithm(jwk.alg), { ...jwk, ext });
    }
    case "EC":
    case "OKP":
      return jwkToKey(keyAlgorithm(alg), { ...jwk, alg, ext });
    default:
      throw new JOSENotSupported('Unsupported "kty" (Key Type) Parameter value');
  }
}
class AuthError extends Error {
  constructor(code, message2) {
    super(message2);
    this.code = code;
  }
  code;
}
const encoder$1 = new TextEncoder();
const decoder = new TextDecoder();
function tokenFromRequest(request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer "))
    return authorization.slice(7).trim();
  if (authorization?.toLowerCase().startsWith("basic ")) {
    try {
      const encoded = authorization.slice(6).trim();
      const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
      const decoded = decoder.decode(
        Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
      );
      const separator = decoded.indexOf(":");
      return separator < 0 ? decoded : decoded.slice(separator + 1);
    } catch {
      throw new AuthError("invalid_token", "malformed basic credentials");
    }
  }
  return void 0;
}
async function hashSecret(value) {
  return encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder$1.encode(value))
    )
  );
}
const ENCODING_ID = "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1";
const MULTIPART_PART_SIZE = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const pattern4 = new RegExp("^[a-z0-9_-]{1,64}$", "u");
const pattern7 = new RegExp("^[0-9abcdfghijklmnpqrsvwxyz]{32}$", "u");
const func1 = (value) => Array.from(value).length;
const schema35 = { "enum": ["pull", "push", "admin"] };
const pattern5 = new RegExp("^(\\*|[a-z0-9_-]{1,64})$", "u");
function validate22(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate22.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.cache === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "cache" }, message: "must have required property 'cache'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.role === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "role" }, message: "must have required property 'role'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "cache" || key0 === "role")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.cache !== void 0) {
      let data0 = data.cache;
      if (typeof data0 === "string") {
        if (!pattern5.test(data0)) {
          const err3 = { instancePath: instancePath + "/cache", schemaPath: "#/properties/cache/pattern", keyword: "pattern", params: { pattern: "^(\\*|[a-z0-9_-]{1,64})$" }, message: 'must match pattern "^(\\*|[a-z0-9_-]{1,64})$"' };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/cache", schemaPath: "#/properties/cache/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.role !== void 0) {
      let data1 = data.role;
      if (!(data1 === "pull" || data1 === "push" || data1 === "admin")) {
        const err5 = { instancePath: instancePath + "/role", schemaPath: "#/$defs/role/enum", keyword: "enum", params: { allowedValues: schema35.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate22.errors = vErrors;
  return errors === 0;
}
validate22.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const schema38 = { "properties": { "deriver": { "type": ["string", "null"] }, "ca": { "type": ["string", "null"] } } };
const pattern8 = new RegExp("^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-.+$", "u");
const pattern9 = new RegExp("^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$", "u");
const GrantSchemaValidator = validate36;
function validate36(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate36.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.cache === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "cache" }, message: "must have required property 'cache'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.role === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "role" }, message: "must have required property 'role'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "cache" || key0 === "role")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.cache !== void 0) {
      let data0 = data.cache;
      if (typeof data0 === "string") {
        if (!pattern5.test(data0)) {
          const err3 = { instancePath: instancePath + "/cache", schemaPath: "#/properties/cache/pattern", keyword: "pattern", params: { pattern: "^(\\*|[a-z0-9_-]{1,64})$" }, message: 'must match pattern "^(\\*|[a-z0-9_-]{1,64})$"' };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/cache", schemaPath: "#/properties/cache/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.role !== void 0) {
      let data1 = data.role;
      if (!(data1 === "pull" || data1 === "push" || data1 === "admin")) {
        const err5 = { instancePath: instancePath + "/role", schemaPath: "#/$defs/role/enum", keyword: "enum", params: { allowedValues: schema35.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate36.errors = vErrors;
  return errors === 0;
}
validate36.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const ManifestSchemaValidator = validate37;
function validate37(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate37.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.cache === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "cache" }, message: "must have required property 'cache'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.store_hash === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "store_hash" }, message: "must have required property 'store_hash'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.store_path === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "store_path" }, message: "must have required property 'store_path'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.nar_hash === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "nar_hash" }, message: "must have required property 'nar_hash'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.nar_size === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "nar_size" }, message: "must have required property 'nar_size'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.references === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "references" }, message: "must have required property 'references'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "cache" || key0 === "store_hash" || key0 === "store_path" || key0 === "nar_hash" || key0 === "nar_size" || key0 === "references" || key0 === "deriver" || key0 === "ca")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.cache !== void 0) {
      let data0 = data.cache;
      if (typeof data0 === "string") {
        if (!pattern4.test(data0)) {
          const err7 = { instancePath: instancePath + "/cache", schemaPath: "#/properties/cache/pattern", keyword: "pattern", params: { pattern: "^[a-z0-9_-]{1,64}$" }, message: 'must match pattern "^[a-z0-9_-]{1,64}$"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/cache", schemaPath: "#/properties/cache/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.store_hash !== void 0) {
      let data1 = data.store_hash;
      if (typeof data1 === "string") {
        if (!pattern7.test(data1)) {
          const err9 = { instancePath: instancePath + "/store_hash", schemaPath: "#/properties/store_hash/pattern", keyword: "pattern", params: { pattern: "^[0-9abcdfghijklmnpqrsvwxyz]{32}$" }, message: 'must match pattern "^[0-9abcdfghijklmnpqrsvwxyz]{32}$"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/store_hash", schemaPath: "#/properties/store_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.store_path !== void 0) {
      let data2 = data.store_path;
      if (typeof data2 === "string") {
        if (func1(data2) > 512) {
          const err11 = { instancePath: instancePath + "/store_path", schemaPath: "#/properties/store_path/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
        if (!pattern8.test(data2)) {
          const err12 = { instancePath: instancePath + "/store_path", schemaPath: "#/properties/store_path/pattern", keyword: "pattern", params: { pattern: "^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-.+$" }, message: 'must match pattern "^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-.+$"' };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      } else {
        const err13 = { instancePath: instancePath + "/store_path", schemaPath: "#/properties/store_path/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.nar_hash !== void 0) {
      let data3 = data.nar_hash;
      if (typeof data3 === "string") {
        if (!pattern9.test(data3)) {
          const err14 = { instancePath: instancePath + "/nar_hash", schemaPath: "#/properties/nar_hash/pattern", keyword: "pattern", params: { pattern: "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$" }, message: 'must match pattern "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$"' };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = { instancePath: instancePath + "/nar_hash", schemaPath: "#/properties/nar_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.nar_size !== void 0) {
      let data4 = data.nar_size;
      if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
        const err16 = { instancePath: instancePath + "/nar_size", schemaPath: "#/properties/nar_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 > 10737418240 || isNaN(data4)) {
          const err17 = { instancePath: instancePath + "/nar_size", schemaPath: "#/properties/nar_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 10737418240 }, message: "must be <= 10737418240" };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
        if (data4 < 1 || isNaN(data4)) {
          const err18 = { instancePath: instancePath + "/nar_size", schemaPath: "#/properties/nar_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      }
    }
    if (data.references !== void 0) {
      let data5 = data.references;
      if (Array.isArray(data5)) {
        if (data5.length > 1024) {
          const err19 = { instancePath: instancePath + "/references", schemaPath: "#/properties/references/maxItems", keyword: "maxItems", params: { limit: 1024 }, message: "must NOT have more than 1024 items" };
          if (vErrors === null) {
            vErrors = [err19];
          } else {
            vErrors.push(err19);
          }
          errors++;
        }
        const len0 = data5.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data6 = data5[i0];
          if (typeof data6 === "string") {
            if (func1(data6) > 512) {
              const err20 = { instancePath: instancePath + "/references/" + i0, schemaPath: "#/properties/references/items/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
          } else {
            const err21 = { instancePath: instancePath + "/references/" + i0, schemaPath: "#/properties/references/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err21];
            } else {
              vErrors.push(err21);
            }
            errors++;
          }
        }
      } else {
        const err22 = { instancePath: instancePath + "/references", schemaPath: "#/properties/references/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err22];
        } else {
          vErrors.push(err22);
        }
        errors++;
      }
    }
    if (data.deriver !== void 0) {
      let data7 = data.deriver;
      if (typeof data7 !== "string" && data7 !== null) {
        const err23 = { instancePath: instancePath + "/deriver", schemaPath: "#/properties/deriver/type", keyword: "type", params: { type: schema38.properties.deriver.type }, message: "must be string,null" };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
      if (typeof data7 === "string") {
        if (func1(data7) > 512) {
          const err24 = { instancePath: instancePath + "/deriver", schemaPath: "#/properties/deriver/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
          if (vErrors === null) {
            vErrors = [err24];
          } else {
            vErrors.push(err24);
          }
          errors++;
        }
      }
    }
    if (data.ca !== void 0) {
      let data8 = data.ca;
      if (typeof data8 !== "string" && data8 !== null) {
        const err25 = { instancePath: instancePath + "/ca", schemaPath: "#/properties/ca/type", keyword: "type", params: { type: schema38.properties.ca.type }, message: "must be string,null" };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
      if (typeof data8 === "string") {
        if (func1(data8) > 512) {
          const err26 = { instancePath: instancePath + "/ca", schemaPath: "#/properties/ca/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
          if (vErrors === null) {
            vErrors = [err26];
          } else {
            vErrors.push(err26);
          }
          errors++;
        }
      }
    }
  } else {
    const err27 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err27];
    } else {
      vErrors.push(err27);
    }
    errors++;
  }
  validate37.errors = vErrors;
  return errors === 0;
}
validate37.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const CreateCacheSchemaValidator = validate38;
function validate38(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate38.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.name === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.quota_bytes === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "quota_bytes" }, message: "must have required property 'quota_bytes'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "name" || key0 === "public" || key0 === "quota_bytes" || key0 === "encoding_id")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      let data0 = data.name;
      if (typeof data0 === "string") {
        if (!pattern4.test(data0)) {
          const err3 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/pattern", keyword: "pattern", params: { pattern: "^[a-z0-9_-]{1,64}$" }, message: 'must match pattern "^[a-z0-9_-]{1,64}$"' };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/name", schemaPath: "#/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.public !== void 0) {
      if (typeof data.public !== "boolean") {
        const err5 = { instancePath: instancePath + "/public", schemaPath: "#/properties/public/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.quota_bytes !== void 0) {
      let data2 = data.quota_bytes;
      if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
        const err6 = { instancePath: instancePath + "/quota_bytes", schemaPath: "#/properties/quota_bytes/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 > 9007199254740991 || isNaN(data2)) {
          const err7 = { instancePath: instancePath + "/quota_bytes", schemaPath: "#/properties/quota_bytes/maximum", keyword: "maximum", params: { comparison: "<=", limit: 9007199254740991 }, message: "must be <= 9007199254740991" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
        if (data2 < 1 || isNaN(data2)) {
          const err8 = { instancePath: instancePath + "/quota_bytes", schemaPath: "#/properties/quota_bytes/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      }
    }
    if (data.encoding_id !== void 0) {
      if ("fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1" !== data.encoding_id) {
        const err9 = { instancePath: instancePath + "/encoding_id", schemaPath: "#/properties/encoding_id/const", keyword: "const", params: { allowedValue: "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
  } else {
    const err10 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate38.errors = vErrors;
  return errors === 0;
}
validate38.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const ConfigureCacheSchemaValidator = validate39;
function validate39(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate39.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.public === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "public" }, message: "must have required property 'public'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "public")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.public !== void 0) {
      if (typeof data.public !== "boolean") {
        const err2 = { instancePath: instancePath + "/public", schemaPath: "#/properties/public/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
  } else {
    const err3 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate39.errors = vErrors;
  return errors === 0;
}
validate39.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const TokenRequestSchemaValidator = validate41;
function validate41(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate41.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.subject === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "subject" }, message: "must have required property 'subject'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.valid_for_seconds === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "valid_for_seconds" }, message: "must have required property 'valid_for_seconds'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.grants === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "grants" }, message: "must have required property 'grants'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "subject" || key0 === "valid_for_seconds" || key0 === "grants")) {
        const err3 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.subject !== void 0) {
      let data0 = data.subject;
      if (typeof data0 === "string") {
        if (func1(data0) > 256) {
          const err4 = { instancePath: instancePath + "/subject", schemaPath: "#/properties/subject/maxLength", keyword: "maxLength", params: { limit: 256 }, message: "must NOT have more than 256 characters" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
        if (func1(data0) < 1) {
          const err5 = { instancePath: instancePath + "/subject", schemaPath: "#/properties/subject/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/subject", schemaPath: "#/properties/subject/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.valid_for_seconds !== void 0) {
      let data1 = data.valid_for_seconds;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)) && isFinite(data1))) {
        const err7 = { instancePath: instancePath + "/valid_for_seconds", schemaPath: "#/properties/valid_for_seconds/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 > 15768e4 || isNaN(data1)) {
          const err8 = { instancePath: instancePath + "/valid_for_seconds", schemaPath: "#/properties/valid_for_seconds/maximum", keyword: "maximum", params: { comparison: "<=", limit: 15768e4 }, message: "must be <= 157680000" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        if (data1 < 1 || isNaN(data1)) {
          const err9 = { instancePath: instancePath + "/valid_for_seconds", schemaPath: "#/properties/valid_for_seconds/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      }
    }
    if (data.grants !== void 0) {
      let data2 = data.grants;
      if (Array.isArray(data2)) {
        if (data2.length > 256) {
          const err10 = { instancePath: instancePath + "/grants", schemaPath: "#/properties/grants/maxItems", keyword: "maxItems", params: { limit: 256 }, message: "must NOT have more than 256 items" };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
        if (data2.length < 1) {
          const err11 = { instancePath: instancePath + "/grants", schemaPath: "#/properties/grants/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate22(data2[i0], { instancePath: instancePath + "/grants/" + i0, parentData: data2, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err12 = { instancePath: instancePath + "/grants", schemaPath: "#/properties/grants/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
  } else {
    const err13 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err13];
    } else {
      vErrors.push(err13);
    }
    errors++;
  }
  validate41.errors = vErrors;
  return errors === 0;
}
validate41.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const BootstrapRequestSchemaValidator = validate43;
function validate43(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate43.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.subject === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "subject" }, message: "must have required property 'subject'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.valid_for_seconds === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "valid_for_seconds" }, message: "must have required property 'valid_for_seconds'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.grants === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "grants" }, message: "must have required property 'grants'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.secret === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "secret" }, message: "must have required property 'secret'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "subject" || key0 === "valid_for_seconds" || key0 === "grants" || key0 === "secret")) {
        const err4 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.subject !== void 0) {
      let data0 = data.subject;
      if (typeof data0 === "string") {
        if (func1(data0) > 256) {
          const err5 = { instancePath: instancePath + "/subject", schemaPath: "#/properties/subject/maxLength", keyword: "maxLength", params: { limit: 256 }, message: "must NOT have more than 256 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
        if (func1(data0) < 1) {
          const err6 = { instancePath: instancePath + "/subject", schemaPath: "#/properties/subject/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = { instancePath: instancePath + "/subject", schemaPath: "#/properties/subject/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.valid_for_seconds !== void 0) {
      let data1 = data.valid_for_seconds;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)) && isFinite(data1))) {
        const err8 = { instancePath: instancePath + "/valid_for_seconds", schemaPath: "#/properties/valid_for_seconds/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
      if (typeof data1 == "number" && isFinite(data1)) {
        if (data1 > 15768e4 || isNaN(data1)) {
          const err9 = { instancePath: instancePath + "/valid_for_seconds", schemaPath: "#/properties/valid_for_seconds/maximum", keyword: "maximum", params: { comparison: "<=", limit: 15768e4 }, message: "must be <= 157680000" };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
        if (data1 < 1 || isNaN(data1)) {
          const err10 = { instancePath: instancePath + "/valid_for_seconds", schemaPath: "#/properties/valid_for_seconds/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      }
    }
    if (data.grants !== void 0) {
      let data2 = data.grants;
      if (Array.isArray(data2)) {
        if (data2.length > 256) {
          const err11 = { instancePath: instancePath + "/grants", schemaPath: "#/properties/grants/maxItems", keyword: "maxItems", params: { limit: 256 }, message: "must NOT have more than 256 items" };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
        if (data2.length < 1) {
          const err12 = { instancePath: instancePath + "/grants", schemaPath: "#/properties/grants/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate22(data2[i0], { instancePath: instancePath + "/grants/" + i0, parentData: data2, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate22.errors : vErrors.concat(validate22.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err13 = { instancePath: instancePath + "/grants", schemaPath: "#/properties/grants/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.secret !== void 0) {
      let data4 = data.secret;
      if (typeof data4 === "string") {
        if (func1(data4) < 1) {
          const err14 = { instancePath: instancePath + "/secret", schemaPath: "#/properties/secret/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = { instancePath: instancePath + "/secret", schemaPath: "#/properties/secret/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
  } else {
    const err16 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err16];
    } else {
      vErrors.push(err16);
    }
    errors++;
  }
  validate43.errors = vErrors;
  return errors === 0;
}
validate43.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const UploadRequestSchemaValidator = validate45;
function validate45(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate45.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.manifest === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "manifest" }, message: "must have required property 'manifest'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.compressed_size === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "compressed_size" }, message: "must have required property 'compressed_size'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "manifest" || key0 === "compressed_size")) {
        const err2 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.manifest !== void 0) {
      let data0 = data.manifest;
      if (data0 && typeof data0 == "object" && !Array.isArray(data0)) {
        if (data0.cache === void 0) {
          const err3 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/required", keyword: "required", params: { missingProperty: "cache" }, message: "must have required property 'cache'" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
        if (data0.store_hash === void 0) {
          const err4 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/required", keyword: "required", params: { missingProperty: "store_hash" }, message: "must have required property 'store_hash'" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
        if (data0.store_path === void 0) {
          const err5 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/required", keyword: "required", params: { missingProperty: "store_path" }, message: "must have required property 'store_path'" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
        if (data0.nar_hash === void 0) {
          const err6 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/required", keyword: "required", params: { missingProperty: "nar_hash" }, message: "must have required property 'nar_hash'" };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
        if (data0.nar_size === void 0) {
          const err7 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/required", keyword: "required", params: { missingProperty: "nar_size" }, message: "must have required property 'nar_size'" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
        if (data0.references === void 0) {
          const err8 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/required", keyword: "required", params: { missingProperty: "references" }, message: "must have required property 'references'" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        for (const key1 in data0) {
          if (!(key1 === "cache" || key1 === "store_hash" || key1 === "store_path" || key1 === "nar_hash" || key1 === "nar_size" || key1 === "references" || key1 === "deriver" || key1 === "ca")) {
            const err9 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
            if (vErrors === null) {
              vErrors = [err9];
            } else {
              vErrors.push(err9);
            }
            errors++;
          }
        }
        if (data0.cache !== void 0) {
          let data1 = data0.cache;
          if (typeof data1 === "string") {
            if (!pattern4.test(data1)) {
              const err10 = { instancePath: instancePath + "/manifest/cache", schemaPath: "#/$defs/manifest/properties/cache/pattern", keyword: "pattern", params: { pattern: "^[a-z0-9_-]{1,64}$" }, message: 'must match pattern "^[a-z0-9_-]{1,64}$"' };
              if (vErrors === null) {
                vErrors = [err10];
              } else {
                vErrors.push(err10);
              }
              errors++;
            }
          } else {
            const err11 = { instancePath: instancePath + "/manifest/cache", schemaPath: "#/$defs/manifest/properties/cache/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err11];
            } else {
              vErrors.push(err11);
            }
            errors++;
          }
        }
        if (data0.store_hash !== void 0) {
          let data2 = data0.store_hash;
          if (typeof data2 === "string") {
            if (!pattern7.test(data2)) {
              const err12 = { instancePath: instancePath + "/manifest/store_hash", schemaPath: "#/$defs/manifest/properties/store_hash/pattern", keyword: "pattern", params: { pattern: "^[0-9abcdfghijklmnpqrsvwxyz]{32}$" }, message: 'must match pattern "^[0-9abcdfghijklmnpqrsvwxyz]{32}$"' };
              if (vErrors === null) {
                vErrors = [err12];
              } else {
                vErrors.push(err12);
              }
              errors++;
            }
          } else {
            const err13 = { instancePath: instancePath + "/manifest/store_hash", schemaPath: "#/$defs/manifest/properties/store_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err13];
            } else {
              vErrors.push(err13);
            }
            errors++;
          }
        }
        if (data0.store_path !== void 0) {
          let data3 = data0.store_path;
          if (typeof data3 === "string") {
            if (func1(data3) > 512) {
              const err14 = { instancePath: instancePath + "/manifest/store_path", schemaPath: "#/$defs/manifest/properties/store_path/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
              if (vErrors === null) {
                vErrors = [err14];
              } else {
                vErrors.push(err14);
              }
              errors++;
            }
            if (!pattern8.test(data3)) {
              const err15 = { instancePath: instancePath + "/manifest/store_path", schemaPath: "#/$defs/manifest/properties/store_path/pattern", keyword: "pattern", params: { pattern: "^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-.+$" }, message: 'must match pattern "^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-.+$"' };
              if (vErrors === null) {
                vErrors = [err15];
              } else {
                vErrors.push(err15);
              }
              errors++;
            }
          } else {
            const err16 = { instancePath: instancePath + "/manifest/store_path", schemaPath: "#/$defs/manifest/properties/store_path/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err16];
            } else {
              vErrors.push(err16);
            }
            errors++;
          }
        }
        if (data0.nar_hash !== void 0) {
          let data4 = data0.nar_hash;
          if (typeof data4 === "string") {
            if (!pattern9.test(data4)) {
              const err17 = { instancePath: instancePath + "/manifest/nar_hash", schemaPath: "#/$defs/manifest/properties/nar_hash/pattern", keyword: "pattern", params: { pattern: "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$" }, message: 'must match pattern "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$"' };
              if (vErrors === null) {
                vErrors = [err17];
              } else {
                vErrors.push(err17);
              }
              errors++;
            }
          } else {
            const err18 = { instancePath: instancePath + "/manifest/nar_hash", schemaPath: "#/$defs/manifest/properties/nar_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        if (data0.nar_size !== void 0) {
          let data5 = data0.nar_size;
          if (!(typeof data5 == "number" && (!(data5 % 1) && !isNaN(data5)) && isFinite(data5))) {
            const err19 = { instancePath: instancePath + "/manifest/nar_size", schemaPath: "#/$defs/manifest/properties/nar_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
            if (vErrors === null) {
              vErrors = [err19];
            } else {
              vErrors.push(err19);
            }
            errors++;
          }
          if (typeof data5 == "number" && isFinite(data5)) {
            if (data5 > 10737418240 || isNaN(data5)) {
              const err20 = { instancePath: instancePath + "/manifest/nar_size", schemaPath: "#/$defs/manifest/properties/nar_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 10737418240 }, message: "must be <= 10737418240" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
            if (data5 < 1 || isNaN(data5)) {
              const err21 = { instancePath: instancePath + "/manifest/nar_size", schemaPath: "#/$defs/manifest/properties/nar_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
              if (vErrors === null) {
                vErrors = [err21];
              } else {
                vErrors.push(err21);
              }
              errors++;
            }
          }
        }
        if (data0.references !== void 0) {
          let data6 = data0.references;
          if (Array.isArray(data6)) {
            if (data6.length > 1024) {
              const err22 = { instancePath: instancePath + "/manifest/references", schemaPath: "#/$defs/manifest/properties/references/maxItems", keyword: "maxItems", params: { limit: 1024 }, message: "must NOT have more than 1024 items" };
              if (vErrors === null) {
                vErrors = [err22];
              } else {
                vErrors.push(err22);
              }
              errors++;
            }
            const len0 = data6.length;
            for (let i0 = 0; i0 < len0; i0++) {
              let data7 = data6[i0];
              if (typeof data7 === "string") {
                if (func1(data7) > 512) {
                  const err23 = { instancePath: instancePath + "/manifest/references/" + i0, schemaPath: "#/$defs/manifest/properties/references/items/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
              } else {
                const err24 = { instancePath: instancePath + "/manifest/references/" + i0, schemaPath: "#/$defs/manifest/properties/references/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err24];
                } else {
                  vErrors.push(err24);
                }
                errors++;
              }
            }
          } else {
            const err25 = { instancePath: instancePath + "/manifest/references", schemaPath: "#/$defs/manifest/properties/references/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err25];
            } else {
              vErrors.push(err25);
            }
            errors++;
          }
        }
        if (data0.deriver !== void 0) {
          let data8 = data0.deriver;
          if (typeof data8 !== "string" && data8 !== null) {
            const err26 = { instancePath: instancePath + "/manifest/deriver", schemaPath: "#/$defs/manifest/properties/deriver/type", keyword: "type", params: { type: schema38.properties.deriver.type }, message: "must be string,null" };
            if (vErrors === null) {
              vErrors = [err26];
            } else {
              vErrors.push(err26);
            }
            errors++;
          }
          if (typeof data8 === "string") {
            if (func1(data8) > 512) {
              const err27 = { instancePath: instancePath + "/manifest/deriver", schemaPath: "#/$defs/manifest/properties/deriver/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
              if (vErrors === null) {
                vErrors = [err27];
              } else {
                vErrors.push(err27);
              }
              errors++;
            }
          }
        }
        if (data0.ca !== void 0) {
          let data9 = data0.ca;
          if (typeof data9 !== "string" && data9 !== null) {
            const err28 = { instancePath: instancePath + "/manifest/ca", schemaPath: "#/$defs/manifest/properties/ca/type", keyword: "type", params: { type: schema38.properties.ca.type }, message: "must be string,null" };
            if (vErrors === null) {
              vErrors = [err28];
            } else {
              vErrors.push(err28);
            }
            errors++;
          }
          if (typeof data9 === "string") {
            if (func1(data9) > 512) {
              const err29 = { instancePath: instancePath + "/manifest/ca", schemaPath: "#/$defs/manifest/properties/ca/maxLength", keyword: "maxLength", params: { limit: 512 }, message: "must NOT have more than 512 characters" };
              if (vErrors === null) {
                vErrors = [err29];
              } else {
                vErrors.push(err29);
              }
              errors++;
            }
          }
        }
      } else {
        const err30 = { instancePath: instancePath + "/manifest", schemaPath: "#/$defs/manifest/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err30];
        } else {
          vErrors.push(err30);
        }
        errors++;
      }
    }
    if (data.compressed_size !== void 0) {
      let data10 = data.compressed_size;
      if (!(typeof data10 == "number" && (!(data10 % 1) && !isNaN(data10)) && isFinite(data10))) {
        const err31 = { instancePath: instancePath + "/compressed_size", schemaPath: "#/properties/compressed_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err31];
        } else {
          vErrors.push(err31);
        }
        errors++;
      }
      if (typeof data10 == "number" && isFinite(data10)) {
        if (data10 > 12884901888 || isNaN(data10)) {
          const err32 = { instancePath: instancePath + "/compressed_size", schemaPath: "#/properties/compressed_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 12884901888 }, message: "must be <= 12884901888" };
          if (vErrors === null) {
            vErrors = [err32];
          } else {
            vErrors.push(err32);
          }
          errors++;
        }
        if (data10 < 1 || isNaN(data10)) {
          const err33 = { instancePath: instancePath + "/compressed_size", schemaPath: "#/properties/compressed_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err33];
          } else {
            vErrors.push(err33);
          }
          errors++;
        }
      }
    }
  } else {
    const err34 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err34];
    } else {
      vErrors.push(err34);
    }
    errors++;
  }
  validate45.errors = vErrors;
  return errors === 0;
}
validate45.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const MissingPathsSchemaValidator = validate46;
function validate46(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate46.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.store_hashes === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "store_hashes" }, message: "must have required property 'store_hashes'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "store_hashes")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.store_hashes !== void 0) {
      let data0 = data.store_hashes;
      if (Array.isArray(data0)) {
        if (data0.length > 100) {
          const err2 = { instancePath: instancePath + "/store_hashes", schemaPath: "#/properties/store_hashes/maxItems", keyword: "maxItems", params: { limit: 100 }, message: "must NOT have more than 100 items" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (typeof data1 === "string") {
            if (!pattern7.test(data1)) {
              const err3 = { instancePath: instancePath + "/store_hashes/" + i0, schemaPath: "#/properties/store_hashes/items/pattern", keyword: "pattern", params: { pattern: "^[0-9abcdfghijklmnpqrsvwxyz]{32}$" }, message: 'must match pattern "^[0-9abcdfghijklmnpqrsvwxyz]{32}$"' };
              if (vErrors === null) {
                vErrors = [err3];
              } else {
                vErrors.push(err3);
              }
              errors++;
            }
          } else {
            const err4 = { instancePath: instancePath + "/store_hashes/" + i0, schemaPath: "#/properties/store_hashes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err4];
            } else {
              vErrors.push(err4);
            }
            errors++;
          }
        }
      } else {
        const err5 = { instancePath: instancePath + "/store_hashes", schemaPath: "#/properties/store_hashes/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate46.errors = vErrors;
  return errors === 0;
}
validate46.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const CompleteUploadSchemaValidator = validate53;
function validate53(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate53.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "parts")) {
        const err0 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.parts !== void 0) {
      let data0 = data.parts;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
            if (data1.part_number === void 0) {
              const err1 = { instancePath: instancePath + "/parts/" + i0, schemaPath: "#/properties/parts/items/required", keyword: "required", params: { missingProperty: "part_number" }, message: "must have required property 'part_number'" };
              if (vErrors === null) {
                vErrors = [err1];
              } else {
                vErrors.push(err1);
              }
              errors++;
            }
            if (data1.etag === void 0) {
              const err2 = { instancePath: instancePath + "/parts/" + i0, schemaPath: "#/properties/parts/items/required", keyword: "required", params: { missingProperty: "etag" }, message: "must have required property 'etag'" };
              if (vErrors === null) {
                vErrors = [err2];
              } else {
                vErrors.push(err2);
              }
              errors++;
            }
            for (const key1 in data1) {
              if (!(key1 === "part_number" || key1 === "etag")) {
                const err3 = { instancePath: instancePath + "/parts/" + i0, schemaPath: "#/properties/parts/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err3];
                } else {
                  vErrors.push(err3);
                }
                errors++;
              }
            }
            if (data1.part_number !== void 0) {
              let data2 = data1.part_number;
              if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
                const err4 = { instancePath: instancePath + "/parts/" + i0 + "/part_number", schemaPath: "#/properties/parts/items/properties/part_number/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                if (vErrors === null) {
                  vErrors = [err4];
                } else {
                  vErrors.push(err4);
                }
                errors++;
              }
              if (typeof data2 == "number" && isFinite(data2)) {
                if (data2 < 1 || isNaN(data2)) {
                  const err5 = { instancePath: instancePath + "/parts/" + i0 + "/part_number", schemaPath: "#/properties/parts/items/properties/part_number/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
                  if (vErrors === null) {
                    vErrors = [err5];
                  } else {
                    vErrors.push(err5);
                  }
                  errors++;
                }
              }
            }
            if (data1.etag !== void 0) {
              let data3 = data1.etag;
              if (typeof data3 === "string") {
                if (func1(data3) < 1) {
                  const err6 = { instancePath: instancePath + "/parts/" + i0 + "/etag", schemaPath: "#/properties/parts/items/properties/etag/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err6];
                  } else {
                    vErrors.push(err6);
                  }
                  errors++;
                }
              } else {
                const err7 = { instancePath: instancePath + "/parts/" + i0 + "/etag", schemaPath: "#/properties/parts/items/properties/etag/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err7];
                } else {
                  vErrors.push(err7);
                }
                errors++;
              }
            }
          } else {
            const err8 = { instancePath: instancePath + "/parts/" + i0, schemaPath: "#/properties/parts/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err8];
            } else {
              vErrors.push(err8);
            }
            errors++;
          }
        }
      } else {
        const err9 = { instancePath: instancePath + "/parts", schemaPath: "#/properties/parts/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
  } else {
    const err10 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate53.errors = vErrors;
  return errors === 0;
}
validate53.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const ChunkManifestSchemaValidator = validate54;
const pattern28 = new RegExp("^chunks/[^/]+/sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}\\.zst$", "u");
function validate54(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate54.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.encoding_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "encoding_id" }, message: "must have required property 'encoding_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.nar_hash === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "nar_hash" }, message: "must have required property 'nar_hash'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.nar_size === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "nar_size" }, message: "must have required property 'nar_size'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.file_hash === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "file_hash" }, message: "must have required property 'file_hash'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.file_size === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "file_size" }, message: "must have required property 'file_size'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.chunks === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "chunks" }, message: "must have required property 'chunks'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.processing_version === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "processing_version" }, message: "must have required property 'processing_version'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.created_at === void 0) {
      const err7 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "encoding_id" || key0 === "nar_hash" || key0 === "nar_size" || key0 === "file_hash" || key0 === "file_size" || key0 === "chunks" || key0 === "processing_version" || key0 === "created_at")) {
        const err8 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.encoding_id !== void 0) {
      if ("fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1" !== data.encoding_id) {
        const err9 = { instancePath: instancePath + "/encoding_id", schemaPath: "#/properties/encoding_id/const", keyword: "const", params: { allowedValue: "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1" }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.nar_hash !== void 0) {
      let data1 = data.nar_hash;
      if (typeof data1 === "string") {
        if (!pattern9.test(data1)) {
          const err10 = { instancePath: instancePath + "/nar_hash", schemaPath: "#/properties/nar_hash/pattern", keyword: "pattern", params: { pattern: "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$" }, message: 'must match pattern "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$"' };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = { instancePath: instancePath + "/nar_hash", schemaPath: "#/properties/nar_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.nar_size !== void 0) {
      let data2 = data.nar_size;
      if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)) && isFinite(data2))) {
        const err12 = { instancePath: instancePath + "/nar_size", schemaPath: "#/properties/nar_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
      if (typeof data2 == "number" && isFinite(data2)) {
        if (data2 > 10737418240 || isNaN(data2)) {
          const err13 = { instancePath: instancePath + "/nar_size", schemaPath: "#/properties/nar_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 10737418240 }, message: "must be <= 10737418240" };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
        if (data2 < 1 || isNaN(data2)) {
          const err14 = { instancePath: instancePath + "/nar_size", schemaPath: "#/properties/nar_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      }
    }
    if (data.file_hash !== void 0) {
      let data3 = data.file_hash;
      if (typeof data3 === "string") {
        if (!pattern9.test(data3)) {
          const err15 = { instancePath: instancePath + "/file_hash", schemaPath: "#/properties/file_hash/pattern", keyword: "pattern", params: { pattern: "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$" }, message: 'must match pattern "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$"' };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
      } else {
        const err16 = { instancePath: instancePath + "/file_hash", schemaPath: "#/properties/file_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.file_size !== void 0) {
      let data4 = data.file_size;
      if (!(typeof data4 == "number" && (!(data4 % 1) && !isNaN(data4)) && isFinite(data4))) {
        const err17 = { instancePath: instancePath + "/file_size", schemaPath: "#/properties/file_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
      if (typeof data4 == "number" && isFinite(data4)) {
        if (data4 > 12884901888 || isNaN(data4)) {
          const err18 = { instancePath: instancePath + "/file_size", schemaPath: "#/properties/file_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 12884901888 }, message: "must be <= 12884901888" };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
        if (data4 < 1 || isNaN(data4)) {
          const err19 = { instancePath: instancePath + "/file_size", schemaPath: "#/properties/file_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err19];
          } else {
            vErrors.push(err19);
          }
          errors++;
        }
      }
    }
    if (data.chunks !== void 0) {
      let data5 = data.chunks;
      if (Array.isArray(data5)) {
        if (data5.length < 1) {
          const err20 = { instancePath: instancePath + "/chunks", schemaPath: "#/properties/chunks/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err20];
          } else {
            vErrors.push(err20);
          }
          errors++;
        }
        const len0 = data5.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data6 = data5[i0];
          if (data6 && typeof data6 == "object" && !Array.isArray(data6)) {
            if (data6.raw_hash === void 0) {
              const err21 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/required", keyword: "required", params: { missingProperty: "raw_hash" }, message: "must have required property 'raw_hash'" };
              if (vErrors === null) {
                vErrors = [err21];
              } else {
                vErrors.push(err21);
              }
              errors++;
            }
            if (data6.raw_size === void 0) {
              const err22 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/required", keyword: "required", params: { missingProperty: "raw_size" }, message: "must have required property 'raw_size'" };
              if (vErrors === null) {
                vErrors = [err22];
              } else {
                vErrors.push(err22);
              }
              errors++;
            }
            if (data6.compressed_hash === void 0) {
              const err23 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/required", keyword: "required", params: { missingProperty: "compressed_hash" }, message: "must have required property 'compressed_hash'" };
              if (vErrors === null) {
                vErrors = [err23];
              } else {
                vErrors.push(err23);
              }
              errors++;
            }
            if (data6.compressed_size === void 0) {
              const err24 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/required", keyword: "required", params: { missingProperty: "compressed_size" }, message: "must have required property 'compressed_size'" };
              if (vErrors === null) {
                vErrors = [err24];
              } else {
                vErrors.push(err24);
              }
              errors++;
            }
            if (data6.key === void 0) {
              const err25 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/required", keyword: "required", params: { missingProperty: "key" }, message: "must have required property 'key'" };
              if (vErrors === null) {
                vErrors = [err25];
              } else {
                vErrors.push(err25);
              }
              errors++;
            }
            for (const key1 in data6) {
              if (!(key1 === "raw_hash" || key1 === "raw_size" || key1 === "compressed_hash" || key1 === "compressed_size" || key1 === "key")) {
                const err26 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err26];
                } else {
                  vErrors.push(err26);
                }
                errors++;
              }
            }
            if (data6.raw_hash !== void 0) {
              let data7 = data6.raw_hash;
              if (typeof data7 === "string") {
                if (!pattern9.test(data7)) {
                  const err27 = { instancePath: instancePath + "/chunks/" + i0 + "/raw_hash", schemaPath: "#/properties/chunks/items/properties/raw_hash/pattern", keyword: "pattern", params: { pattern: "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$" }, message: 'must match pattern "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$"' };
                  if (vErrors === null) {
                    vErrors = [err27];
                  } else {
                    vErrors.push(err27);
                  }
                  errors++;
                }
              } else {
                const err28 = { instancePath: instancePath + "/chunks/" + i0 + "/raw_hash", schemaPath: "#/properties/chunks/items/properties/raw_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err28];
                } else {
                  vErrors.push(err28);
                }
                errors++;
              }
            }
            if (data6.raw_size !== void 0) {
              let data8 = data6.raw_size;
              if (!(typeof data8 == "number" && (!(data8 % 1) && !isNaN(data8)) && isFinite(data8))) {
                const err29 = { instancePath: instancePath + "/chunks/" + i0 + "/raw_size", schemaPath: "#/properties/chunks/items/properties/raw_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                if (vErrors === null) {
                  vErrors = [err29];
                } else {
                  vErrors.push(err29);
                }
                errors++;
              }
              if (typeof data8 == "number" && isFinite(data8)) {
                if (data8 > 9007199254740991 || isNaN(data8)) {
                  const err30 = { instancePath: instancePath + "/chunks/" + i0 + "/raw_size", schemaPath: "#/properties/chunks/items/properties/raw_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 9007199254740991 }, message: "must be <= 9007199254740991" };
                  if (vErrors === null) {
                    vErrors = [err30];
                  } else {
                    vErrors.push(err30);
                  }
                  errors++;
                }
                if (data8 < 1 || isNaN(data8)) {
                  const err31 = { instancePath: instancePath + "/chunks/" + i0 + "/raw_size", schemaPath: "#/properties/chunks/items/properties/raw_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
                  if (vErrors === null) {
                    vErrors = [err31];
                  } else {
                    vErrors.push(err31);
                  }
                  errors++;
                }
              }
            }
            if (data6.compressed_hash !== void 0) {
              let data9 = data6.compressed_hash;
              if (typeof data9 === "string") {
                if (!pattern9.test(data9)) {
                  const err32 = { instancePath: instancePath + "/chunks/" + i0 + "/compressed_hash", schemaPath: "#/properties/chunks/items/properties/compressed_hash/pattern", keyword: "pattern", params: { pattern: "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$" }, message: 'must match pattern "^sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}$"' };
                  if (vErrors === null) {
                    vErrors = [err32];
                  } else {
                    vErrors.push(err32);
                  }
                  errors++;
                }
              } else {
                const err33 = { instancePath: instancePath + "/chunks/" + i0 + "/compressed_hash", schemaPath: "#/properties/chunks/items/properties/compressed_hash/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err33];
                } else {
                  vErrors.push(err33);
                }
                errors++;
              }
            }
            if (data6.compressed_size !== void 0) {
              let data10 = data6.compressed_size;
              if (!(typeof data10 == "number" && (!(data10 % 1) && !isNaN(data10)) && isFinite(data10))) {
                const err34 = { instancePath: instancePath + "/chunks/" + i0 + "/compressed_size", schemaPath: "#/properties/chunks/items/properties/compressed_size/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
                if (vErrors === null) {
                  vErrors = [err34];
                } else {
                  vErrors.push(err34);
                }
                errors++;
              }
              if (typeof data10 == "number" && isFinite(data10)) {
                if (data10 > 9007199254740991 || isNaN(data10)) {
                  const err35 = { instancePath: instancePath + "/chunks/" + i0 + "/compressed_size", schemaPath: "#/properties/chunks/items/properties/compressed_size/maximum", keyword: "maximum", params: { comparison: "<=", limit: 9007199254740991 }, message: "must be <= 9007199254740991" };
                  if (vErrors === null) {
                    vErrors = [err35];
                  } else {
                    vErrors.push(err35);
                  }
                  errors++;
                }
                if (data10 < 1 || isNaN(data10)) {
                  const err36 = { instancePath: instancePath + "/chunks/" + i0 + "/compressed_size", schemaPath: "#/properties/chunks/items/properties/compressed_size/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
                  if (vErrors === null) {
                    vErrors = [err36];
                  } else {
                    vErrors.push(err36);
                  }
                  errors++;
                }
              }
            }
            if (data6.key !== void 0) {
              let data11 = data6.key;
              if (typeof data11 === "string") {
                if (!pattern28.test(data11)) {
                  const err37 = { instancePath: instancePath + "/chunks/" + i0 + "/key", schemaPath: "#/properties/chunks/items/properties/key/pattern", keyword: "pattern", params: { pattern: "^chunks/[^/]+/sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}\\.zst$" }, message: 'must match pattern "^chunks/[^/]+/sha256:[0-9abcdfghijklmnpqrsvwxyz]{52}\\.zst$"' };
                  if (vErrors === null) {
                    vErrors = [err37];
                  } else {
                    vErrors.push(err37);
                  }
                  errors++;
                }
              } else {
                const err38 = { instancePath: instancePath + "/chunks/" + i0 + "/key", schemaPath: "#/properties/chunks/items/properties/key/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err38];
                } else {
                  vErrors.push(err38);
                }
                errors++;
              }
            }
          } else {
            const err39 = { instancePath: instancePath + "/chunks/" + i0, schemaPath: "#/properties/chunks/items/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err39];
            } else {
              vErrors.push(err39);
            }
            errors++;
          }
        }
      } else {
        const err40 = { instancePath: instancePath + "/chunks", schemaPath: "#/properties/chunks/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err40];
        } else {
          vErrors.push(err40);
        }
        errors++;
      }
    }
    if (data.processing_version !== void 0) {
      let data12 = data.processing_version;
      if (typeof data12 === "string") {
        if (func1(data12) > 64) {
          const err41 = { instancePath: instancePath + "/processing_version", schemaPath: "#/properties/processing_version/maxLength", keyword: "maxLength", params: { limit: 64 }, message: "must NOT have more than 64 characters" };
          if (vErrors === null) {
            vErrors = [err41];
          } else {
            vErrors.push(err41);
          }
          errors++;
        }
        if (func1(data12) < 1) {
          const err42 = { instancePath: instancePath + "/processing_version", schemaPath: "#/properties/processing_version/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err42];
          } else {
            vErrors.push(err42);
          }
          errors++;
        }
      } else {
        const err43 = { instancePath: instancePath + "/processing_version", schemaPath: "#/properties/processing_version/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err43];
        } else {
          vErrors.push(err43);
        }
        errors++;
      }
    }
    if (data.created_at !== void 0) {
      let data13 = data.created_at;
      if (!(typeof data13 == "number" && (!(data13 % 1) && !isNaN(data13)) && isFinite(data13))) {
        const err44 = { instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err44];
        } else {
          vErrors.push(err44);
        }
        errors++;
      }
      if (typeof data13 == "number" && isFinite(data13)) {
        if (data13 < 1 || isNaN(data13)) {
          const err45 = { instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err45];
          } else {
            vErrors.push(err45);
          }
          errors++;
        }
      }
    }
  } else {
    const err46 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err46];
    } else {
      vErrors.push(err46);
    }
    errors++;
  }
  validate54.errors = vErrors;
  return errors === 0;
}
validate54.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
const GrantSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/grant",
  validate: GrantSchemaValidator
};
const ManifestSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/manifest",
  validate: ManifestSchemaValidator
};
const CreateCacheSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/create_cache",
  validate: CreateCacheSchemaValidator
};
const ConfigureCacheSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/configure_cache",
  validate: ConfigureCacheSchemaValidator
};
const TokenRequestSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/token_request",
  validate: TokenRequestSchemaValidator
};
const BootstrapRequestSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/bootstrap_request",
  validate: BootstrapRequestSchemaValidator
};
const UploadRequestSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/upload_request",
  validate: UploadRequestSchemaValidator
};
const MissingPathsSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/missing_paths",
  validate: MissingPathsSchemaValidator
};
const CompleteUploadSchema = {
  ref: "https://cf-nix-cache.dev/schemas/api.json#/$defs/complete_upload",
  validate: CompleteUploadSchemaValidator
};
const ChunkManifestSchema = {
  ref: "https://cf-nix-cache.dev/schemas/manifest.json",
  validate: ChunkManifestSchemaValidator
};
class DomainError extends Error {
  constructor(code, message2, status) {
    super(message2);
    this.code = code;
    this.status = status;
  }
  code;
  status;
}
function parseJsonSchema(schema2, value) {
  if (!schema2.validate(value)) {
    const message2 = (schema2.validate.errors ?? []).map(
      (issue) => `${issue.instancePath || "body"}: ${issue.message ?? "is invalid"}`
    ).join("; ");
    throw new DomainError(
      "validation_failed",
      message2 || "request does not match the wire contract",
      422
    );
  }
  return value;
}
const NIX_BASE32$1 = "0123456789abcdfghijklmnpqrsvwxyz";
const NIX32 = new RegExp(`^[${NIX_BASE32$1}]{32}$`);
const CACHE_NAME = /^[a-z0-9_-]{1,64}$/;
function hasControlCharacters(value, includeSlash = false) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127 || includeSlash && character === "/";
  });
}
function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}
function assertCacheName(value) {
  if (typeof value !== "string" || !CACHE_NAME.test(value))
    throw new DomainError("invalid_cache", "invalid cache name", 422);
}
function assertOpaqueId(value, label = "resource") {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DomainError("invalid_id", `invalid ${label} id`, 422);
  }
}
function assertNamespaceId(value, label = "resource") {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new DomainError("invalid_id", `invalid ${label} id`, 422);
}
function assertStoreHash(value) {
  if (typeof value !== "string" || !NIX32.test(value))
    throw new DomainError("invalid_store_hash", "invalid store hash", 422);
}
function assertIdempotencyKey(value) {
  if (!value || value.length > 128 || ![...value].every(
    (character) => character.codePointAt(0) >= 33 && character.codePointAt(0) <= 126
  )) {
    throw new DomainError(
      "idempotency_key_required",
      "a valid Idempotency-Key is required",
      400
    );
  }
  return value;
}
function parseContentLength(request) {
  const value = request.headers.get("content-length");
  const length = value === null ? NaN : Number(value);
  if (!Number.isSafeInteger(length) || length < 0)
    throw new DomainError(
      "length_required",
      "upload parts require a valid Content-Length header",
      411
    );
  return length;
}
const NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz";
function assertSafeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "invalid_number",
      `${label} must be a non-negative safe integer`,
      422
    );
  }
}
function validPathName(value) {
  return new RegExp(`^[${NIX_BASE32}]{32}-.{1,479}$`, "u").test(value) && utf8Bytes(value) <= 512 && !hasControlCharacters(value, true);
}
function validateGrant(grant) {
  return Boolean(GrantSchema.validate(grant));
}
function validateUploadManifest(manifest, compressedSize) {
  const validManifest = parseJsonSchema(ManifestSchema, manifest);
  parseJsonSchema(UploadRequestSchema, {
    manifest: validManifest,
    compressed_size: compressedSize
  });
  assertSafeInteger(compressedSize, "compressed_size");
  assertCacheName(validManifest.cache);
  assertStoreHash(validManifest.store_hash);
  if (utf8Bytes(validManifest.store_path) > 512 || hasControlCharacters(validManifest.store_path)) {
    throw new DomainError(
      "validation_failed",
      "store metadata contains invalid characters",
      422
    );
  }
  const basename = validManifest.store_path.split("/").at(-1) ?? "";
  if (!validManifest.store_path.startsWith("/nix/store/") || validManifest.store_path.split("/").length !== 4 || !basename.startsWith(`${validManifest.store_hash}-`) || basename.length <= validManifest.store_hash.length + 1) {
    throw new DomainError(
      "validation_failed",
      "store path does not match the declared store hash",
      422
    );
  }
  if (new TextEncoder().encode(JSON.stringify(validManifest)).byteLength > MAX_METADATA_BYTES) {
    throw new DomainError(
      "validation_failed",
      "upload metadata is too large",
      422
    );
  }
  if (validManifest.references.some((reference2) => !validPathName(reference2)) || validManifest.deriver != null && !validPathName(validManifest.deriver) || validManifest.ca != null && (utf8Bytes(validManifest.ca) > 512 || hasControlCharacters(validManifest.ca))) {
    throw new DomainError(
      "validation_failed",
      "store metadata contains invalid characters",
      422
    );
  }
}
function requestFingerprint(input) {
  return JSON.stringify({
    compressed_size: input.compressed_size,
    manifest: input.manifest
  });
}
function partsFor(size, partSize) {
  return Math.ceil(size / partSize);
}
function transition(from, to) {
  if (from === to) return;
  const allowed = {
    CREATED: ["UPLOADING", "ABORTED", "FAILED"],
    UPLOADING: ["COMPLETING", "ABORTED", "FAILED"],
    COMPLETING: ["QUEUED", "ABORTED", "FAILED"],
    QUEUED: ["PROCESSING", "ABORTED", "FAILED"],
    PROCESSING: ["PUBLISHING", "FAILED"],
    PUBLISHING: ["READY", "FAILED"],
    READY: [],
    FAILED: [],
    ABORTED: []
  };
  if (!allowed[from].includes(to))
    throw new DomainError(
      "invalid_transition",
      `invalid upload transition from ${from} to ${to}`,
      409
    );
}
function deltaFor(next, previous) {
  return (next?.file_size ?? 0) - (previous?.file_size ?? 0);
}
function claimsFromPayload(payload) {
  if (typeof payload.iss !== "string" || typeof payload.aud !== "string" || typeof payload.sub !== "string" || typeof payload.jti !== "string" || typeof payload.iat !== "number" || typeof payload.exp !== "number" || !Array.isArray(payload.grants) || !payload.grants.every(validateGrant)) {
    throw new Error("token claims do not match the capability contract");
  }
  return {
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    jti: payload.jti,
    iat: payload.iat,
    nbf: typeof payload.nbf === "number" ? payload.nbf : void 0,
    exp: payload.exp,
    grants: payload.grants
  };
}
async function verifySignature(token, env) {
  const configured = JSON.parse(env.AUTH_PUBLIC_JWKS);
  const keySet = createLocalJWKSet({
    keys: configured.map(({ kid, jwk }) => ({ ...jwk, kid }))
  });
  const verified = await jwtVerify(token, keySet, {
    issuer: env.TOKEN_ISSUER,
    audience: env.TOKEN_AUDIENCE,
    algorithms: ["EdDSA"],
    typ: "JWT"
  });
  return claimsFromPayload(verified.payload);
}
const TOKEN_STATUS_CACHE_TTL = 5;
async function verifiedClaims(request, env) {
  const token = tokenFromRequest(request);
  if (!token)
    throw new AuthError("missing_token", "authentication is required");
  try {
    return await verifySignature(token, env);
  } catch (error) {
    throw new AuthError(
      "invalid_token",
      error instanceof Error ? error.message : "invalid token"
    );
  }
}
async function assertActive(env, claims) {
  const key = new Request(
    `https://token-status.invalid/${encodeURIComponent(claims.iss)}/${encodeURIComponent(claims.jti)}?exp=${claims.exp}`
  );
  try {
    const cached2 = await caches.default.match(key);
    if (cached2) return;
  } catch {
  }
  const result = await namedStub(env.TOKEN_CATALOG, "catalog").check({
    jti: claims.jti,
    exp: claims.exp
  });
  if (!result.ok || !result.value.active)
    throw new AuthError("revoked_token", "token is revoked or unknown");
  try {
    void caches.default.put(
      key,
      Response.json(
        { active: true },
        {
          headers: {
            "cache-control": `public, max-age=${TOKEN_STATUS_CACHE_TTL}`
          }
        }
      )
    ).catch(() => void 0);
  } catch {
  }
}
async function authenticateAny(request, env, required) {
  const claims = await verifiedClaims(request, env);
  if (!permitsAny(claims, required))
    throw new AuthError(
      "forbidden",
      "token does not grant the requested capability"
    );
  await assertActive(env, claims);
  return claims;
}
async function authenticate(request, env, cache2, required) {
  const claims = await verifiedClaims(request, env);
  if (!permitsCache(claims, cache2, required))
    throw new AuthError(
      "forbidden",
      "token does not grant the requested capability"
    );
  await assertActive(env, claims);
  return claims;
}
async function authenticateGlobal(request, env, required) {
  const claims = await verifiedClaims(request, env);
  if (!permitsGlobal(claims, required))
    throw new AuthError(
      "forbidden",
      "token does not grant the requested global capability"
    );
  await assertActive(env, claims);
  return claims;
}
function encodeCursor(value) {
  return encode(JSON.stringify(value));
}
function decodeCursor(value) {
  if (!value) return null;
  try {
    return JSON.parse(new TextDecoder().decode(decode(value)));
  } catch {
    throw new DomainError("invalid_cursor", "invalid pagination cursor", 400);
  }
}
class ApiCallError extends Error {
  constructor(status, code, message2) {
    super(message2);
    this.status = status;
    this.code = code;
  }
  status;
  code;
}
async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    throw new DomainError(
      "validation_failed",
      "request body must be valid JSON",
      400
    );
  }
}
function unwrapRpc(result) {
  if (!result.ok)
    throw new ApiCallError(
      result.error.status,
      result.error.code,
      result.error.message
    );
  return result.value;
}
function system(env) {
  return namedStub(env.SYSTEM_CONTROL, "system");
}
function coordinator(env, reference2) {
  return idStub(env.CACHE_COORDINATOR, reference2.coordinator_id);
}
const DIRECTORY_CACHE_TTL = 5;
function effectiveLifecycle(catalogue, coordinatorLifecycle) {
  if (catalogue === "DELETING" || coordinatorLifecycle === "DELETING")
    return "DELETING";
  if (catalogue === "CREATING" || coordinatorLifecycle === "CREATING")
    return "CREATING";
  return "ACTIVE";
}
async function directoryReference(env, name) {
  const key = new Request(`https://directory.invalid/cache/${name}`);
  try {
    const cached2 = await caches.default.match(key);
    if (cached2) return await cached2.json();
  } catch {
  }
  const reference2 = unwrapRpc(await system(env).getCache(name));
  try {
    void caches.default.put(
      key,
      Response.json(reference2, {
        headers: { "cache-control": `max-age=${DIRECTORY_CACHE_TTL}` }
      })
    ).catch(() => void 0);
  } catch {
  }
  return reference2;
}
async function getCache(env, name) {
  assertCacheName(name);
  let reference2 = await directoryReference(env, name);
  if (!reference2.lifecycle)
    reference2 = unwrapRpc(await system(env).getCache(name));
  let configResult = await coordinator(env, reference2).getCache();
  if (!configResult.ok && configResult.error.code === "not_found") {
    reference2 = unwrapRpc(await system(env).getCache(name));
    configResult = await coordinator(env, reference2).getCache();
  }
  const config = unwrapRpc(configResult);
  return {
    ...config,
    // SystemControl is the lifecycle saga authority. During activation and
    // teardown it may intentionally lead the coordinator by one step.
    lifecycle: effectiveLifecycle(reference2.lifecycle, config.lifecycle),
    reference: reference2
  };
}
function publicCache(cache2) {
  return {
    id: cache2.id,
    name: cache2.name,
    public: cache2.public,
    quota_bytes: cache2.quota_bytes,
    logical_bytes: cache2.logical_bytes,
    encoding_id: cache2.encoding_id,
    created_at: cache2.created_at,
    lifecycle: cache2.lifecycle
  };
}
async function getPath$1(env, cache2, storeHash) {
  assertStoreHash(storeHash);
  const shard = idStub(
    env.CACHE_INDEX,
    env.CACHE_INDEX.idFromName(
      `${cache2.reference.incarnation}:${storeHash.slice(0, 2)}`
    )
  );
  return unwrapRpc(await shard.lookup(storeHash));
}
function isNotFound(error) {
  return error instanceof ApiCallError && error.code === "not_found";
}
async function authFor(request, env, cache2, required) {
  if (cache2.lifecycle !== "ACTIVE")
    throw new AuthError(
      cache2.lifecycle === "DELETING" ? "cache_deleting" : "cache_unavailable",
      "cache is not active"
    );
  if (required === "pull" && cache2.public) return { sub: "anonymous" };
  return authenticate(request, env, cache2.name, required);
}
function idempotency(request) {
  return assertIdempotencyKey(request.headers.get("Idempotency-Key"));
}
async function issueFromInput(env, input, operationId, parent) {
  const validated = parseJsonSchema(TokenRequestSchema, input);
  const issuedAt = Math.floor(Date.now() / 1e3);
  const expiresAt = issuedAt + validated.valid_for_seconds;
  if (parent && !canDelegate(parent, validated.grants, expiresAt))
    throw new DomainError(
      "forbidden",
      "requested grants must be individually covered by an administrator grant and expire no later than the issuer",
      403
    );
  const fingerprint = JSON.stringify(validated);
  return unwrapRpc(
    await namedStub(env.TOKEN_CATALOG, "catalog").issue({
      operation_id: operationId,
      fingerprint,
      actor: parent?.sub ?? validated.subject,
      subject: validated.subject,
      grants: validated.grants,
      expires_at: expiresAt
    })
  );
}
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();
var bufferToFormData = (arrayBuffer, contentType) => {
  const response = new Response(arrayBuffer, {
    headers: {
      // Normalize the media type (case-insensitive) while keeping parameters like the boundary
      "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase())
    }
  });
  return response.formData();
};
var isRawRequest = (request) => "headers" in request;
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const contentType = headers.get("Content-Type");
  const mediaType = contentType?.split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    return parseFormData(request, { all, dot });
  }
  return {};
};
async function parseFormData(request, options) {
  if (!isRawRequest(request) && request.bodyCache.formData) {
    return convertFormDataToBodyData(
      await request.bodyCache.formData,
      options
    );
  }
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const arrayBuffer = await request.arrayBuffer();
  const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
  if (!isRawRequest(request)) {
    request.bodyCache.formData = formDataPromise;
  }
  const formData = await formDataPromise;
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
};
var handleParsingNestedValues = (form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
};
var tryDecode = (str, decoder2) => {
  try {
    return decoder2(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder2(match2);
      } catch {
        return match2;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var tryDecodeURIComponent = (str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str;
var _decodeURI = (value) => {
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return tryDecodeURIComponent(value);
};
var _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && key.indexOf("%") === -1 && key.indexOf("+") === -1) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = /* @__PURE__ */ Object.create(null);
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;
var HonoRequest = class {
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && tryDecodeURIComponent(param);
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = tryDecodeURIComponent(value);
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = /* @__PURE__ */ Object.create(null);
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    for (const anyCachedKey in bodyCache) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw[key]();
  };
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    (this.#validatedData ??= {})[target] = data;
  }
  valid(target) {
    return this.#validatedData?.[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};
var HtmlEscapedCallbackPhase = {
  Stringify: 1
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  {
    return resStr;
  }
};
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = (layout) => this.#layout = layout;
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = () => this.#layout;
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
    if (typeof arg === "object" && arg.headers) {
      responseHeaders ??= new Headers();
      for (const [key, value] of new Headers(arg.headers)) {
        if (key === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      if (!responseHeaders) {
        let count = 0;
        for (const k in headers) {
          if (++count > 1 || typeof headers[k] !== "string") {
            responseHeaders = new Headers();
            break;
          }
        }
      }
      if (responseHeaders) {
        for (const k in headers) {
          const v = headers[k];
          if (typeof v === "string") {
            responseHeaders.set(k, v);
          } else {
            responseHeaders.delete(k);
            for (const v2 of v) {
              responseHeaders.append(k, v2);
            }
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders ?? headers
    });
  }
  newResponse = (...args) => this.#newResponse(...args);
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  };
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = (object, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object),
      arg,
      setDefaultContentType("application/json", headers)
    );
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = (location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  };
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch", "query"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono$1 = class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  query;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request) => request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} env - env Object
   * @param {ExecutionContext} executionCtx - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  };
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = () => {
    addEventListener("fetch", (event2) => {
      event2.respondWith(this.#dispatch(event2.request, event2, void 0, event2.request.method));
    });
  };
};
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = ((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  });
  this.match = match2;
  return match2(method, path);
}
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return b === TAIL_WILDCARD_REG_EXP_STR ? -1 : 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node$1 = class _Node {
  // handler index of a dynamic path, or -1 for a static path terminal
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, isStatic) {
    let node = this;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i];
      const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : null : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let nextNode;
      if (pattern) {
        const name = pattern[1];
        let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
        if (name && pattern[2]) {
          if (regexpStr === ".*") {
            throw PATH_ERROR;
          }
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(regexpStr)) {
            throw PATH_ERROR;
          }
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) {
            throw PATH_ERROR;
          }
        }
        nextNode = node.#children[regexpStr];
        if (!nextNode) {
          if (regexpStr !== ONLY_WILDCARD_REG_EXP_STR && regexpStr !== TAIL_WILDCARD_REG_EXP_STR) {
            for (const k in node.#children) {
              if (
                // a single-char pattern coexists with single-char literals as a literal does
                (regexpStr.length > 1 || k.length > 1) && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
              ) {
                throw PATH_ERROR;
              }
            }
          }
          nextNode = node.#children[regexpStr] = new _Node();
        }
        if (name !== "") {
          nextNode.#varIndex ??= context.varIndex++;
          paramMap.push([name, nextNode.#varIndex]);
        }
      } else {
        nextNode = node.#children[token];
        if (!nextNode) {
          for (const k in node.#children) {
            if (k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR) {
              throw PATH_ERROR;
            }
          }
          nextNode = node.#children[token] = new _Node();
        }
      }
      node = nextNode;
    }
    if (node.#index !== void 0) {
      throw PATH_ERROR;
    }
    node.#index = isStatic ? -1 : index;
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      const childStr = c.buildRegExpStr();
      return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
    }).filter(Boolean);
    if (typeof this.#index === "number" && this.#index !== -1) {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node$1();
  #index = 0;
  // dynamic path -> [handler index, param assoc]; static paths are not registered
  paths = /* @__PURE__ */ Object.create(null);
  insert(path, isStatic) {
    if (isStatic) {
      this.#root.insert(path.split(""), 0, [], this.#context, true);
      return;
    }
    const paramAssoc = [];
    const groups = [];
    let markedPath = path;
    for (let i = 0; ; ) {
      let replaced = false;
      markedPath = markedPath.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, false);
    this.paths[path] = [this.#index++, paramAssoc];
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  #tries;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#tries = { [METHOD_NAME_ALL]: new Trie() };
  }
  #insertPath(method, path) {
    try {
      this.#tries[method].insert(path, !/\*|\/:/.test(path));
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      this.#tries[method] = new Trie();
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
          this.#insertPath(method, p);
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      Object.keys(middleware).forEach((m) => {
        if ((method === METHOD_NAME_ALL || method === m) && !middleware[m][path]) {
          this.#insertPath(m, path);
          middleware[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        }
      });
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length; i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          if (!routes[m][path2]) {
            this.#insertPath(m, path2);
            routes[m][path2] = [
              ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
            ];
          }
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = this.#tries = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const middleware = this.#middleware[method];
    const routes = this.#routes[method];
    const trie = this.#tries[method];
    const staticMap = /* @__PURE__ */ Object.create(null);
    const handlerData = [];
    [middleware, routes].forEach((r) => {
      for (const path in r) {
        const handlers = r[path];
        const pathData = trie.paths[path];
        if (!pathData) {
          staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
          continue;
        }
        const paramAssoc = pathData[1];
        handlerData[pathData[0]] = handlers.map(([h, paramCount]) => {
          const paramIndexMap = /* @__PURE__ */ Object.create(null);
          paramCount -= 1;
          for (; paramCount >= 0; paramCount--) {
            const [key, value] = paramAssoc[paramCount];
            paramIndexMap[key] = value;
          }
          return [h, paramIndexMap];
        });
      }
    });
    const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
    for (let i = 0, len = handlerData.length; i < len; i++) {
      for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
        const map = handlerData[i][j]?.[1];
        if (!map) {
          continue;
        }
        const keys = Object.keys(map);
        for (let k = 0, len3 = keys.length; k < len3; k++) {
          map[keys[k]] = paramReplacementMap[map[keys[k]]];
        }
      }
    }
    const handlerMap = [];
    for (const i in indexReplacementMap) {
      handlerMap[i] = handlerData[indexReplacementMap[i]];
    }
    return [regexp, handlerMap, staticMap];
  }
};
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = (children) => {
  for (const _ in children) {
    return true;
  }
  return false;
};
var Node = class _Node2 {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (m[0].length === restPathString.length && child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  node.#params,
                  params
                );
              }
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//g)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};
var TrieRouter = class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};
var Hono = class extends Hono$1 {
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
};
class PublicationApplication {
  constructor(index, quota) {
    this.index = index;
    this.quota = quota;
  }
  index;
  quota;
  async execute(operationId, mutation) {
    const prepared = await this.index.prepare(operationId, mutation);
    if (prepared.status === "ABORTED")
      throw new PublicationError(
        "operation was aborted before publication",
        false
      );
    try {
      const reservation = await this.quota.reserve(operationId, prepared.delta);
      if (reservation.status === "ABORTED")
        throw new PublicationError("quota operation was aborted", false);
    } catch (error) {
      if (error instanceof PublicationError && !error.retryable)
        await this.index.abort(operationId);
      throw error;
    }
    if (prepared.status !== "COMMITTED") await this.index.commit(operationId);
    await this.quota.finalize(operationId);
    return prepared;
  }
}
class PublicationError extends Error {
  constructor(message2, retryable) {
    super(message2);
    this.retryable = retryable;
  }
  retryable;
}
class RangeRequestError extends Error {
  constructor(message2) {
    super(message2);
  }
}
function parseRange(value, size) {
  if (!value) return null;
  const match2 = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match2 || !match2[1] && !match2[2] || size === 0)
    throw new RangeRequestError("invalid range");
  const suffix = !match2[1] && Boolean(match2[2]);
  const start = suffix ? Math.max(0, size - Number(match2[2])) : Number(match2[1]);
  const end = suffix || !match2[2] ? size - 1 : Number(match2[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
    throw new RangeRequestError("range not satisfiable");
  return { start, end: Math.min(end, size - 1) };
}
function planRange(chunks, range) {
  const start = range?.start ?? 0;
  const end = range?.end ?? chunks.reduce((total, chunk) => total + chunk.compressed_size, 0) - 1;
  let cursor = 0;
  const plan = [];
  for (const chunk of chunks) {
    const chunkStart = cursor;
    const chunkEnd = cursor + chunk.compressed_size - 1;
    const overlapStart = Math.max(start, chunkStart);
    const overlapEnd = Math.min(end, chunkEnd);
    if (overlapStart <= overlapEnd) {
      plan.push({
        chunk,
        offset: overlapStart - chunkStart,
        length: overlapEnd - overlapStart + 1,
        output_offset: overlapStart - start
      });
    }
    cursor += chunk.compressed_size;
  }
  return plan;
}
function errorResponse(c, code, message2, status) {
  return Response.json(
    { code, message: message2, request_id: c.get("requestId") },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-request-id": c.get("requestId")
      }
    }
  );
}
function errorStatus(error) {
  if (error.code === "missing_token") return 401;
  if (error.code === "cache_deleting") return 410;
  if (error.code === "cache_unavailable") return 503;
  return 403;
}
function handleError(caught, c) {
  if (caught instanceof AuthError)
    return errorResponse(c, caught.code, caught.message, errorStatus(caught));
  if (caught instanceof DomainError)
    return errorResponse(c, caught.code, caught.message, caught.status);
  if (caught instanceof ApiCallError)
    return errorResponse(c, caught.code, caught.message, caught.status);
  if (caught instanceof PublicationError)
    return errorResponse(
      c,
      "retryable_failure",
      caught.message,
      caught.retryable ? 503 : 409
    );
  if (caught instanceof RangeRequestError)
    return errorResponse(c, "range_not_satisfiable", caught.message, 416);
  console.error({ request_id: c.get("requestId"), error: caught });
  return errorResponse(c, "internal_error", "internal server error", 500);
}
class DeleteCacheWorkflow extends WorkflowEntrypoint {
  async run(event2, step) {
    const job = event2.payload;
    const cache2 = coordinator(this.env, {
      id: job.cache_id,
      name: job.cache,
      incarnation: job.incarnation,
      coordinator_id: job.coordinator_id
    });
    let deleted = 0;
    for (let prefix = 0; prefix < 256; prefix += 1) {
      const value = prefix.toString(16).padStart(2, "0");
      const count = await step.do(`clear shard ${value}`, async () => {
        const shardId = this.env.CACHE_INDEX.idFromName(`${job.incarnation}:${value}`).toString();
        const shard = idStub(this.env.CACHE_INDEX, shardId);
        const cleared = await shard.clear(
          `clear:${job.incarnation}:${job.operation_id}:${value}`
        );
        if (!cleared.ok)
          throw new Error(
            `unable to clear shard ${value}: ${cleared.error.message}`
          );
        const reconciled = await cache2.reconcile({
          operation_ids: cleared.value.reconcile_operation_ids
        });
        if (!reconciled.ok)
          throw new Error(
            `unable to reconcile shard ${value} publications: ${reconciled.error.message}`
          );
        const applied = await cache2.clearDelta({
          operation_id: `clear:${job.incarnation}:${job.operation_id}:${value}`,
          delta: -cleared.value.bytes
        });
        if (!applied.ok)
          throw new Error(
            `unable to apply shard ${value} quota delta: ${applied.error.message}`
          );
        return cleared.value.deleted;
      });
      deleted += count;
    }
    await step.do("flush cache audit", async () => {
      const flushed = await cache2.flushAudit();
      if (!flushed.ok)
        throw new Error(
          `unable to flush cache audit: ${flushed.error.message}`
        );
      return { flushed: true };
    });
    await step.do("remove cache storage", async () => {
      const removed = await cache2.remove();
      if (!removed.ok)
        throw new Error(
          `unable to remove cache coordinator: ${removed.error.message}`
        );
      const catalog = await system(this.env).removeCache({
        id: job.cache_id,
        name: job.cache,
        incarnation: job.incarnation,
        coordinator_id: job.coordinator_id
      });
      if (!catalog.ok)
        throw new Error(
          `unable to remove cache catalog: ${catalog.error.message}`
        );
      return { removed: true };
    });
    return { deleted };
  }
}
async function ensureWorkflow(workflow, id, params) {
  try {
    await workflow.createBatch([{ id, params }]);
    return;
  } catch (createError) {
    try {
      const instance = await workflow.get(id);
      const status = await instance.status();
      if (status.status === "errored" || status.status === "terminated")
        await instance.restart();
      return;
    } catch (lookupError) {
      throw new Error(
        `workflow enqueue failed for ${id}: ${createError instanceof Error ? createError.message : String(createError)}; reconciliation failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
        { cause: lookupError }
      );
    }
  }
}
class PermanentWorkflowError extends Error {
}
class ProcessUploadWorkflow extends WorkflowEntrypoint {
  async run(event2, step) {
    const job = event2.payload;
    const upload = idStub(this.env.UPLOAD_JOB, job.job_id);
    try {
      await step.do("claim upload", async () => {
        const result = await upload.processing();
        if (!result.ok)
          throw new (result.error.status >= 500 ? Error : PermanentWorkflowError)(`${result.error.code}: ${result.error.message}`);
        return { ok: true };
      });
      const processed = await step.do(
        "process NAR",
        { retries: { limit: 4, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const response = await this.env.PROCESSOR.getByName(job.job_id).fetch("https://processor/process", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(job)
          });
          if (response.status === 503)
            throw new Error(
              `processor temporary failure: ${await response.text()}`
            );
          if (!response.ok)
            return {
              permanent_error: `processor rejected input with ${response.status}: ${await response.text()}`
            };
          return { result: await response.json() };
        }
      );
      if ("permanent_error" in processed)
        throw new PermanentWorkflowError(processed.permanent_error);
      const publication = await step.do(
        "publish authoritative manifest",
        { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const result = await upload.publish(processed.result);
          if (!result.ok) {
            if (result.error.status >= 500)
              throw new Error(`${result.error.code}: ${result.error.message}`);
            return {
              permanent_error: `${result.error.code}: ${result.error.message}`
            };
          }
          return { published: true };
        }
      );
      if ("permanent_error" in publication)
        throw new PermanentWorkflowError(publication.permanent_error);
      return processed.result;
    } catch (caught) {
      const message2 = caught instanceof Error ? caught.message : String(caught);
      const terminal = caught instanceof PermanentWorkflowError;
      await step.do("mark failed", async () => {
        const result = await upload.fail(message2, terminal);
        if (!result.ok)
          throw new Error(
            `unable to mark upload failed: ${result.error.message}`
          );
        return { failed: true };
      });
      throw caught;
    }
  }
}
function pageLimit(value) {
  const parsed = Number(value ?? 50);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}
function event(id, actor, action, resource, outcome) {
  return {
    id,
    timestamp: Math.floor(Date.now() / 1e3),
    actor,
    action,
    resource,
    outcome,
    metadata: {}
  };
}
const cacheRoutes = new Hono();
cacheRoutes.post("/api/caches", async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticateGlobal(c.req.raw, c.env, "admin");
  const input = parseJsonSchema(CreateCacheSchema, await parseJson(c.req.raw));
  const creation = unwrapRpc(
    await system(c.env).createCache({
      operation_id: operationId,
      fingerprint: JSON.stringify(input),
      name: input.name,
      public: input.public ?? false,
      quota_bytes: input.quota_bytes,
      encoding_id: input.encoding_id ?? ENCODING_ID
    })
  );
  const reference2 = creation.reference;
  const cacheCoordinator = coordinator(c.env, reference2);
  unwrapRpc(
    await cacheCoordinator.initialize({
      reference: reference2,
      public: input.public ?? false,
      quota_bytes: input.quota_bytes,
      encoding_id: input.encoding_id ?? ENCODING_ID,
      created_at: Math.floor(Date.now() / 1e3)
    })
  );
  const active = unwrapRpc(await cacheCoordinator.activate());
  unwrapRpc(await system(c.env).activateCache(reference2));
  unwrapRpc(
    await cacheCoordinator.recordAudit(
      event(
        `cache-create:${operationId}`,
        admin.sub,
        "cache.create",
        input.name,
        "success"
      )
    )
  );
  return c.json(
    publicCache({ ...active }),
    creation.repeated ? 200 : 201
  );
});
cacheRoutes.get("/api/caches", async (c) => {
  await authenticate(c.req.raw, c.env, "*", "admin");
  const limit = pageLimit(c.req.query("limit"));
  const after = decodeCursor(c.req.query("cursor") ?? null) ?? null;
  const page = unwrapRpc(await system(c.env).listCaches({ after, limit }));
  const items = await Promise.all(
    page.items.map(async (reference2) => {
      const config = unwrapRpc(await coordinator(c.env, reference2).getCache());
      return publicCache({
        ...config,
        lifecycle: effectiveLifecycle(reference2.lifecycle, config.lifecycle)
      });
    })
  );
  return c.json({
    items,
    next_cursor: page.next_after ? encodeCursor(page.next_after) : null
  });
});
cacheRoutes.get("/api/caches/:name", async (c) => {
  const name = c.req.param("name");
  assertCacheName(name);
  const cache2 = await getCache(c.env, name);
  await authenticate(c.req.raw, c.env, "*", "admin");
  return c.json(publicCache(cache2));
});
cacheRoutes.delete("/api/caches/:name", async (c) => {
  const operationId = idempotency(c.req.raw);
  const name = c.req.param("name");
  assertCacheName(name);
  const cache2 = await getCache(c.env, name);
  const admin = await authenticate(c.req.raw, c.env, cache2.name, "admin");
  const deletion = unwrapRpc(
    await system(c.env).beginDelete({
      reference: cache2.reference,
      operation_id: operationId
    })
  );
  unwrapRpc(await coordinator(c.env, cache2.reference).beginDelete());
  unwrapRpc(
    await coordinator(c.env, cache2.reference).recordAudit(
      event(
        `cache-delete:${operationId}`,
        admin.sub,
        "cache.delete",
        cache2.name,
        "accepted"
      )
    )
  );
  await ensureWorkflow(
    c.env.DELETE_CACHE,
    `delete:${cache2.reference.incarnation}`,
    {
      cache: cache2.name,
      cache_id: cache2.reference.id,
      incarnation: cache2.reference.incarnation,
      coordinator_id: cache2.reference.coordinator_id,
      operation_id: deletion.operation_id
    }
  );
  return c.json({ deleting: true }, 202);
});
cacheRoutes.patch("/api/caches/:name/config", async (c) => {
  const operationId = idempotency(c.req.raw);
  const name = c.req.param("name");
  assertCacheName(name);
  const cache2 = await getCache(c.env, name);
  const admin = await authenticate(c.req.raw, c.env, cache2.name, "admin");
  const input = parseJsonSchema(
    ConfigureCacheSchema,
    await parseJson(c.req.raw)
  );
  const updated = unwrapRpc(
    await coordinator(c.env, cache2.reference).configure(input)
  );
  unwrapRpc(
    await coordinator(c.env, cache2.reference).recordAudit(
      event(
        `cache-config:${operationId}`,
        admin.sub,
        "cache.configure",
        cache2.name,
        "success"
      )
    )
  );
  return c.json(updated);
});
function unwrapPublication(result, cache2) {
  if (!result.ok)
    throw new PublicationError(
      `${cache2}: ${result.error.message}`,
      result.error.status >= 500
    );
  return result.value;
}
class DurableCacheIndexAdapter {
  constructor(stub, cache2) {
    this.stub = stub;
    this.cache = cache2;
  }
  stub;
  cache;
  async prepare(operationId, mutation) {
    if (mutation.kind === "clear")
      throw new PublicationError("clear is not a path publication", false);
    const request = mutation.kind === "upsert" ? { kind: "upsert", record: mutation.record } : { kind: "delete", store_hash: mutation.store_hash };
    return {
      ...unwrapPublication(
        await this.stub.prepare({
          operation_id: operationId,
          mutation: request
        }),
        this.cache
      ),
      cache: this.cache
    };
  }
  async commit(operationId) {
    return {
      ...unwrapPublication(await this.stub.commit(operationId), this.cache),
      cache: this.cache
    };
  }
  async abort(operationId) {
    unwrapPublication(await this.stub.abort(operationId), this.cache);
  }
}
class DurableQuotaLedgerAdapter {
  constructor(stub) {
    this.stub = stub;
  }
  stub;
  async reserve(operationId, delta) {
    return unwrapPublication(
      await this.stub.reserve({ operation_id: operationId, delta }),
      "quota"
    );
  }
  async finalize(operationId) {
    unwrapPublication(
      await this.stub.finalize({ operation_id: operationId }),
      "quota"
    );
  }
  async abort(operationId) {
    unwrapPublication(
      await this.stub.abort({ operation_id: operationId }),
      "quota"
    );
  }
}
function publicationFor(env, cache2, storeHash) {
  const index = idStub(
    env.CACHE_INDEX,
    env.CACHE_INDEX.idFromName(
      `${cache2.reference.incarnation}:${storeHash.slice(0, 2)}`
    )
  );
  const quota = idStub(env.CACHE_COORDINATOR, cache2.reference.coordinator_id);
  return new PublicationApplication(
    new DurableCacheIndexAdapter(index, cache2.name),
    new DurableQuotaLedgerAdapter(quota)
  );
}
const pathRoutes = new Hono();
pathRoutes.post("/api/caches/:name/missing", async (c) => {
  const name = c.req.param("name");
  assertCacheName(name);
  const cache2 = await getCache(c.env, name);
  idempotency(c.req.raw);
  await authFor(c.req.raw, c.env, cache2, "push");
  const input = parseJsonSchema(MissingPathsSchema, await parseJson(c.req.raw));
  const missing = [];
  for (const storeHash of input.store_hashes) {
    assertStoreHash(storeHash);
    try {
      await getPath$1(c.env, cache2, storeHash);
    } catch (caught) {
      if (isNotFound(caught)) missing.push(storeHash);
      else throw caught;
    }
  }
  return c.json({ missing });
});
pathRoutes.delete("/api/caches/:name/paths/:storeHash", async (c) => {
  const operationId = idempotency(c.req.raw);
  const name = c.req.param("name");
  assertCacheName(name);
  const cache2 = await getCache(c.env, name);
  const admin = await authenticate(c.req.raw, c.env, cache2.name, "admin");
  const storeHash = c.req.param("storeHash");
  assertStoreHash(storeHash);
  const prepared = await publicationFor(c.env, cache2, storeHash).execute(
    `delete:${cache2.reference.incarnation}:${storeHash}:${operationId}`,
    { kind: "delete", store_hash: storeHash }
  );
  unwrapRpc(
    await coordinator(c.env, cache2.reference).recordAudit(
      event(
        `path-delete:${operationId}`,
        admin.sub,
        "path.delete",
        `${cache2.name}/${storeHash}`,
        "success"
      )
    )
  );
  return c.json({ deleted: Boolean(prepared.previous) });
});
const AUDIT_SHARD_COUNT = 16;
function shardNumber(eventId) {
  let hash = 2166136261;
  for (const character of eventId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % AUDIT_SHARD_COUNT;
}
function auditShardName(eventId) {
  return `audit:${shardNumber(eventId).toString(16).padStart(2, "0")}`;
}
function auditShardNames() {
  return Array.from(
    { length: AUDIT_SHARD_COUNT },
    (_, index) => `audit:${index.toString(16).padStart(2, "0")}`
  ).concat("audit");
}
function auditStub(env, eventId) {
  return idStub(
    env.AUDIT_LOG,
    env.AUDIT_LOG.idFromName(auditShardName(eventId))
  );
}
const tokenRoutes = new Hono();
tokenRoutes.post("/api/bootstrap", async (c) => {
  const operationId = idempotency(c.req.raw);
  const input = parseJsonSchema(
    BootstrapRequestSchema,
    await parseJson(c.req.raw)
  );
  const now2 = Math.floor(Date.now() / 1e3);
  const result = unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, "catalog").bootstrap({
      operation_id: operationId,
      fingerprint: JSON.stringify({
        subject: input.subject,
        valid_for_seconds: input.valid_for_seconds,
        grants: input.grants
      }),
      subject: input.subject,
      grants: input.grants,
      expires_at: now2 + input.valid_for_seconds,
      secret: input.secret
    })
  );
  return c.json(result, result.repeated ? 200 : 201);
});
tokenRoutes.post("/api/tokens", async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticateAny(c.req.raw, c.env, "admin");
  const input = parseJsonSchema(TokenRequestSchema, await parseJson(c.req.raw));
  const result = await issueFromInput(
    c.env,
    input,
    `token:${operationId}`,
    admin
  );
  return c.json(result, result.repeated ? 200 : 201);
});
tokenRoutes.get("/api/tokens", async (c) => {
  await authenticate(c.req.raw, c.env, "*", "admin");
  const result = unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, "catalog").list({
      limit: pageLimit(c.req.query("limit")),
      cursor: c.req.query("cursor") ?? null
    })
  );
  return c.json(result);
});
tokenRoutes.delete("/api/tokens/:jti", async (c) => {
  const operationId = idempotency(c.req.raw);
  const admin = await authenticate(c.req.raw, c.env, "*", "admin");
  const jti = c.req.param("jti");
  assertOpaqueId(jti, "token");
  unwrapRpc(
    await namedStub(c.env.TOKEN_CATALOG, "catalog").revoke({
      operation_id: `revoke:${operationId}`,
      jti,
      actor: admin.sub
    })
  );
  return c.json({ revoked: true });
});
tokenRoutes.get("/api/audit", async (c) => {
  await authenticate(c.req.raw, c.env, "*", "admin");
  const limit = pageLimit(c.req.query("limit"));
  const cursor = c.req.query("cursor") ?? null;
  const pages = await Promise.all(
    auditShardNames().map(
      async (name) => unwrapRpc(await namedStub(c.env.AUDIT_LOG, name).list({ limit, cursor }))
    )
  );
  const items = pages.flatMap((page) => page.items).sort(
    (left, right) => right.timestamp !== left.timestamp ? right.timestamp - left.timestamp : right.id === left.id ? 0 : right.id > left.id ? 1 : -1
  );
  const selected = items.slice(0, limit);
  const hasMore = items.length > limit || pages.some((page) => page.next_cursor !== null);
  const last = selected.at(-1);
  return c.json({
    items: selected,
    next_cursor: hasMore && last ? encodeCursor({ timestamp: last.timestamp, id: last.id }) : null
  });
});
const controlRoutes = new Hono();
controlRoutes.get("/health", (c) => c.json({ status: "ok" }));
controlRoutes.get(
  "/api/public-key",
  (c) => new Response(`${c.env.NIX_PUBLIC_KEYS.trim()}
`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  })
);
controlRoutes.route("", tokenRoutes);
controlRoutes.route("", cacheRoutes);
controlRoutes.route("", pathRoutes);
async function serveNarObject(c, cache2, storeHash, record, requestId) {
  const request = c.req.raw;
  const object = await c.env.CACHE_BUCKET.get(record.manifest_key);
  if (!object)
    return Response.json(
      {
        code: "corrupt_manifest",
        message: "manifest is missing",
        request_id: requestId
      },
      { status: 500 }
    );
  const manifest = parseJsonSchema(
    ChunkManifestSchema,
    await object.json()
  );
  const total = manifest.chunks.reduce(
    (sum, chunk) => sum + chunk.compressed_size,
    0
  );
  if (total !== manifest.file_size)
    return Response.json(
      {
        code: "corrupt_manifest",
        message: "manifest chunk sizes do not match file size",
        request_id: requestId
      },
      { status: 500 }
    );
  const range = parseRange(request.headers.get("range"), manifest.file_size);
  const plan = planRange(manifest.chunks, range);
  const status = range ? 206 : 200;
  const headers = new Headers({
    "content-type": "application/x-nix-nar",
    "accept-ranges": "bytes",
    "cache-control": cache2.public ? (
      // A store hash can be deliberately replaced through the control plane.
      // Keep this response's lifetime aligned with narinfo so a replacement
      // cannot leave clients serving an old NAR for a year.
      "public, max-age=300"
    ) : "private, no-store",
    etag: `"${manifest.file_hash}"`,
    "content-length": String(
      range ? range.end - range.start + 1 : manifest.file_size
    )
  });
  if (range)
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${manifest.file_size}`
    );
  c.executionCtx.waitUntil(
    idStub(
      c.env.CACHE_INDEX,
      c.env.CACHE_INDEX.idFromName(
        `${cache2.reference.incarnation}:${storeHash.slice(0, 2)}`
      )
    ).touch(storeHash).catch((error) => console.error("cache touch failed", error))
  );
  if (request.method === "HEAD") return new Response(null, { status, headers });
  let planIndex = 0;
  let reader = null;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            const item = plan[planIndex++];
            if (!item) {
              controller.close();
              return;
            }
            const chunk = await c.env.CACHE_BUCKET.get(item.chunk.key, {
              range: { offset: item.offset, length: item.length }
            });
            if (!chunk?.body)
              throw new Error(`missing chunk ${item.chunk.key}`);
            reader = chunk.body.getReader();
          }
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            reader = null;
            continue;
          }
          controller.enqueue(next.value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      reader = null;
    }
  });
  return new Response(stream, { status, headers });
}
const nixRoutes = new Hono();
async function nixHandler(c) {
  const request = c.req.raw;
  const requestId = c.get("requestId");
  if (request.method !== "GET" && request.method !== "HEAD")
    return Response.json(
      {
        code: "method_not_allowed",
        message: "method not allowed",
        request_id: requestId
      },
      { status: 405 }
    );
  const cacheName = c.req.param("cache") ?? "";
  assertCacheName(cacheName);
  const suffix = c.req.param("path") ?? "";
  const cache2 = await getCache(c.env, cacheName);
  if (cache2.lifecycle === "DELETING")
    return Response.json(
      {
        code: "cache_deleting",
        message: "cache is being deleted",
        request_id: requestId
      },
      { status: 410 }
    );
  if (cache2.lifecycle !== "ACTIVE")
    return Response.json(
      {
        code: "cache_unavailable",
        message: "cache is not active",
        request_id: requestId
      },
      { status: 503 }
    );
  const narInfo = /^([0-9abcdfghijklmnpqrsvwxyz]{32})\.narinfo$/.exec(suffix);
  const narObject = /^nar\/([0-9abcdfghijklmnpqrsvwxyz]{32})\.nar\.zst$/.exec(
    suffix
  );
  if (suffix === "nix-cache-info") {
    await authFor(request, c.env, cache2, "pull");
    return new Response(
      request.method === "HEAD" ? null : "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n",
      {
        headers: {
          "content-type": "text/plain",
          "cache-control": cache2.public ? "public, max-age=300" : "private, no-store"
        }
      }
    );
  }
  if (!narInfo && !narObject)
    return Response.json(
      {
        code: "not_found",
        message: "path not found",
        request_id: requestId
      },
      { status: 404 }
    );
  const storeHash = (narInfo ?? narObject)[1];
  await authFor(request, c.env, cache2, "pull");
  let record;
  try {
    record = await getPath$1(c.env, cache2, storeHash);
  } catch (error) {
    if (isNotFound(error))
      return Response.json(
        {
          code: "not_found",
          message: "path not found",
          request_id: requestId
        },
        { status: 404 }
      );
    throw error;
  }
  if (narInfo)
    return new Response(request.method === "HEAD" ? null : record.narinfo, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        etag: `"${record.file_hash}"`,
        "cache-control": cache2.public ? "public, max-age=300" : "private, no-store"
      }
    });
  return serveNarObject(c, cache2, storeHash, record, requestId);
}
nixRoutes.all("/cache/:cache/:path{.+}", nixHandler);
nixRoutes.all("/cache/:cache", nixHandler);
async function uploadAccess(c) {
  const id = c.req.param("id");
  assertNamespaceId(id, "upload");
  const job = idStub(c.env.UPLOAD_JOB, id);
  const access = unwrapRpc(await job.access());
  const cache2 = await getCache(c.env, access.cache);
  await authFor(c.req.raw, c.env, cache2, "push");
  return { id, cache: cache2, job };
}
function stateResponse(value) {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}
const uploadRoutes = new Hono();
uploadRoutes.post("/api/uploads", async (c) => {
  const key = idempotency(c.req.raw);
  const input = parseJsonSchema(
    UploadRequestSchema,
    await parseJson(c.req.raw)
  );
  validateUploadManifest(input.manifest, input.compressed_size);
  const cache2 = await getCache(c.env, input.manifest.cache);
  await authFor(c.req.raw, c.env, cache2, "push");
  const fingerprint = requestFingerprint(input);
  const allocation = unwrapRpc(
    await coordinator(c.env, cache2.reference).allocateUpload({
      operation_id: key,
      fingerprint
    })
  );
  const job = idStub(c.env.UPLOAD_JOB, allocation.id);
  const state2 = unwrapRpc(
    await job.init({
      job_id: allocation.id,
      cache: cache2.name,
      cache_id: cache2.reference.id,
      incarnation: cache2.reference.incarnation,
      staging_key: allocation.staging_key,
      manifest: input.manifest,
      compressed_size: input.compressed_size,
      idempotency_key: key,
      fingerprint
    })
  );
  const parts = partsFor(input.compressed_size, MULTIPART_PART_SIZE);
  const result = {
    id: allocation.id,
    status: state2.state,
    error: null,
    parts: Array.from({ length: parts }, (_, index) => ({
      part_number: index + 1,
      url: `${new URL(c.req.url).origin}/api/uploads/${allocation.id}/parts/${index + 1}`
    }))
  };
  return c.json(result, allocation.repeated ? 200 : 201);
});
uploadRoutes.put("/api/uploads/:id/parts/:number", async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  const number = Number(c.req.param("number"));
  const result = unwrapRpc(
    await job.putPart({
      number,
      length: parseContentLength(c.req.raw),
      body: c.req.raw.body
    })
  );
  return new Response(null, {
    status: 200,
    headers: { etag: result.etag, "cache-control": "no-store" }
  });
});
uploadRoutes.post("/api/uploads/:id/complete", async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  const input = await parseJson(c.req.raw);
  const result = unwrapRpc(
    await job.complete(input)
  );
  return stateResponse(result);
});
uploadRoutes.get("/api/uploads/:id/state", async (c) => {
  const { job } = await uploadAccess(c);
  return stateResponse(unwrapRpc(await job.state()));
});
uploadRoutes.get("/api/uploads/:id", async (c) => {
  const { job } = await uploadAccess(c);
  return stateResponse(unwrapRpc(await job.state()));
});
uploadRoutes.delete("/api/uploads/:id", async (c) => {
  const { job } = await uploadAccess(c);
  idempotency(c.req.raw);
  return stateResponse(unwrapRpc(await job.abort()));
});
function createApp() {
  const app2 = new Hono();
  app2.use("*", async (c, next) => {
    const id = crypto.randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  });
  app2.route("", controlRoutes);
  app2.route("", uploadRoutes);
  app2.route("", nixRoutes);
  app2.notFound((c) => errorResponse(c, "not_found", "route not found", 404));
  app2.onError((caught, c) => handleError(caught, c));
  return app2;
}
const app = createApp();
function now() {
  return Math.floor(Date.now() / 1e3);
}
function initialize(ctx, sql) {
  ctx.storage.sql.exec(sql);
}
const failure$5 = (code, message2, status) => ({ ok: false, error: { code, message: message2, status } });
function toCache(row) {
  return {
    id: String(row.cache_id),
    name: String(row.name),
    public: Number(row.public) === 1,
    quota_bytes: Number(row.quota_bytes),
    logical_bytes: Number(row.logical_bytes),
    encoding_id: String(row.encoding_id),
    created_at: Number(row.created_at),
    lifecycle: String(row.lifecycle)
  };
}
class CoordinatorAudit {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  ctx;
  env;
  async record(event2) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO audit_outbox (event_id, event, created_at) VALUES (?, ?, ?)",
        event2.id,
        JSON.stringify(event2),
        now()
      );
    });
    this.ctx.waitUntil(this.drain());
    return { ok: true, value: void 0 };
  }
  async flush() {
    while (true) {
      if (!await this.drain())
        return failure$5(
          "audit_unavailable",
          "audit log is unavailable; retry before removing the cache",
          503
        );
      const pending = [
        ...this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM audit_outbox"
        )
      ][0];
      if (!pending || Number(pending.count) === 0)
        return { ok: true, value: void 0 };
    }
  }
  async shardId(prefix) {
    if (!/^[0-9a-f]{2}$/u.test(prefix))
      return failure$5("invalid_shard", "invalid cache index shard", 422);
    const row = [
      ...this.ctx.storage.sql.exec(
        "SELECT incarnation FROM cache LIMIT 1"
      )
    ][0];
    return row ? {
      ok: true,
      value: this.env.CACHE_INDEX.idFromName(`${row.incarnation}:${prefix}`).toString()
    } : failure$5("not_found", "cache not found", 404);
  }
  async alarm() {
    await this.drain();
  }
  async drain() {
    const rows = [
      ...this.ctx.storage.sql.exec(
        "SELECT event_id, event FROM audit_outbox ORDER BY created_at LIMIT 50"
      )
    ];
    if (!rows.length) return true;
    for (const row of rows) {
      const event2 = JSON.parse(String(row.event));
      const result = await auditStub(this.env, event2.id).append(event2);
      if (!result.ok) {
        await this.ctx.storage.setAlarm(Date.now() + 3e4);
        return false;
      }
      this.ctx.storage.transactionSync(
        () => this.ctx.storage.sql.exec(
          "DELETE FROM audit_outbox WHERE event_id = ?",
          row.event_id
        )
      );
    }
    const pending = [
      ...this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM audit_outbox"
      )
    ][0];
    if (pending && Number(pending.count) > 0)
      await this.ctx.storage.setAlarm(Date.now() + 1e3);
    return true;
  }
}
class CoordinatorQuota {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  async reserve(input) {
    return this.ctx.storage.transactionSync(() => {
      const old = [
        ...this.ctx.storage.sql.exec(
          "SELECT delta, status FROM quota_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (old) {
        if (Number(old.delta) !== input.delta)
          return failure$5(
            "operation_conflict",
            "operation delta changed during retry",
            409
          );
        return {
          ok: true,
          value: {
            operation_id: input.operation_id,
            delta: input.delta,
            status: old.status
          }
        };
      }
      const cache2 = [
        ...this.ctx.storage.sql.exec("SELECT lifecycle, logical_bytes, quota_bytes FROM cache LIMIT 1")
      ][0];
      if (!cache2) return failure$5("not_found", "cache not found", 404);
      if (cache2.lifecycle !== "ACTIVE")
        return failure$5(
          cache2.lifecycle === "DELETING" ? "cache_deleting" : "cache_unavailable",
          "cache is not active",
          cache2.lifecycle === "DELETING" ? 410 : 503
        );
      const pending = [
        ...this.ctx.storage.sql.exec(
          "SELECT COALESCE(SUM(CASE WHEN status = 'RESERVED' AND delta > 0 THEN delta ELSE 0 END), 0) AS value FROM quota_operations"
        )
      ][0]?.value ?? 0;
      if (!Number.isSafeInteger(input.delta) || Number(cache2.logical_bytes) + Number(pending) + input.delta > Number(cache2.quota_bytes))
        return failure$5("quota_exceeded", "cache quota exceeded", 409);
      if (Number(cache2.logical_bytes) + input.delta < 0)
        return failure$5("quota_invariant", "quota would become negative", 409);
      this.ctx.storage.sql.exec(
        "INSERT INTO quota_operations (operation_id, delta, status) VALUES (?, ?, 'RESERVED')",
        input.operation_id,
        input.delta
      );
      return {
        ok: true,
        value: {
          operation_id: input.operation_id,
          delta: input.delta,
          status: "RESERVED"
        }
      };
    });
  }
  async finalize(input) {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec(
          "SELECT delta, status FROM quota_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (!row)
        return failure$5("operation_not_found", "quota operation not found", 404);
      if (row.status === "FINALIZED") return { ok: true, value: void 0 };
      if (row.status === "ABORTED")
        return failure$5("operation_aborted", "quota operation was aborted", 409);
      this.ctx.storage.sql.exec(
        "UPDATE cache SET logical_bytes = logical_bytes + ?",
        Number(row.delta)
      );
      this.ctx.storage.sql.exec(
        "UPDATE quota_operations SET status = 'FINALIZED' WHERE operation_id = ? AND status = 'RESERVED'",
        input.operation_id
      );
      return { ok: true, value: void 0 };
    });
  }
  async abort(input) {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE quota_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'RESERVED'",
        input.operation_id
      );
      return { ok: true, value: void 0 };
    });
  }
  /**
   * Reconcile publications whose index commit became visible before quota
   * finalization. This is used by cache teardown after an index shard has been
   * fenced and before its bytes are removed from the logical quota total.
   */
  async reconcile(input) {
    return this.ctx.storage.transactionSync(() => {
      for (const operationId of input.operation_ids) {
        const row = [
          ...this.ctx.storage.sql.exec(
            "SELECT delta, status FROM quota_operations WHERE operation_id = ?",
            operationId
          )
        ][0];
        if (!row) continue;
        if (row.status === "ABORTED" || row.status === "FINALIZED") continue;
        this.ctx.storage.sql.exec(
          "UPDATE cache SET logical_bytes = logical_bytes + ? ",
          Number(row.delta)
        );
        this.ctx.storage.sql.exec(
          "UPDATE quota_operations SET status = 'FINALIZED' WHERE operation_id = ? AND status = 'RESERVED'",
          operationId
        );
      }
      return { ok: true, value: void 0 };
    });
  }
  async clearDelta(input) {
    return this.ctx.storage.transactionSync(() => {
      if (input.delta > 0 || !Number.isSafeInteger(input.delta))
        return failure$5(
          "quota_invariant",
          "cache clear delta must be a negative safe integer",
          409
        );
      const old = [
        ...this.ctx.storage.sql.exec(
          "SELECT delta FROM clear_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (old)
        return Number(old.delta) === input.delta ? { ok: true, value: void 0 } : failure$5(
          "operation_conflict",
          "clear operation delta changed during retry",
          409
        );
      const cache2 = [
        ...this.ctx.storage.sql.exec(
          "SELECT logical_bytes FROM cache LIMIT 1"
        )
      ][0];
      if (!cache2 || Number(cache2.logical_bytes) + input.delta < 0)
        return failure$5(
          "quota_invariant",
          "cache bytes would become negative",
          409
        );
      this.ctx.storage.sql.exec(
        "UPDATE cache SET logical_bytes = logical_bytes + ?",
        input.delta
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO clear_operations (operation_id, delta) VALUES (?, ?)",
        input.operation_id,
        input.delta
      );
      return { ok: true, value: void 0 };
    });
  }
}
class CoordinatorState {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  async initialize(input) {
    return this.ctx.storage.transactionSync(() => {
      const existing = [
        ...this.ctx.storage.sql.exec("SELECT * FROM cache LIMIT 1")
      ][0];
      if (existing) {
        if (String(existing.cache_id) !== input.reference.id || String(existing.incarnation) !== input.reference.incarnation || Number(existing.quota_bytes) !== input.quota_bytes || Number(existing.public) !== (input.public ? 1 : 0) || String(existing.encoding_id) !== input.encoding_id) {
          return failure$5(
            "coordinator_conflict",
            "cache coordinator is already assigned to another incarnation",
            409
          );
        }
        return { ok: true, value: toCache(existing) };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO cache (cache_id, name, incarnation, public, quota_bytes, encoding_id, created_at, lifecycle) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATING')",
        input.reference.id,
        input.reference.name,
        input.reference.incarnation,
        input.public ? 1 : 0,
        input.quota_bytes,
        input.encoding_id,
        input.created_at
      );
      return {
        ok: true,
        value: {
          id: input.reference.id,
          name: input.reference.name,
          public: input.public,
          quota_bytes: input.quota_bytes,
          logical_bytes: 0,
          encoding_id: input.encoding_id,
          created_at: input.created_at,
          lifecycle: "CREATING"
        }
      };
    });
  }
  async getCache() {
    const row = [
      ...this.ctx.storage.sql.exec("SELECT * FROM cache LIMIT 1")
    ][0];
    return row ? { ok: true, value: toCache(row) } : failure$5("not_found", "cache not found", 404);
  }
  async configure(input) {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec("SELECT * FROM cache LIMIT 1")
      ][0];
      if (!row) return failure$5("not_found", "cache not found", 404);
      if (String(row.lifecycle) === "DELETING")
        return failure$5("cache_deleting", "cache is being deleted", 410);
      this.ctx.storage.sql.exec(
        "UPDATE cache SET public = ?",
        input.public ? 1 : 0
      );
      return {
        ok: true,
        value: toCache({ ...row, public: input.public ? 1 : 0 })
      };
    });
  }
  async activate() {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec("SELECT * FROM cache LIMIT 1")
      ][0];
      if (!row) return failure$5("not_found", "cache not found", 404);
      if (String(row.lifecycle) === "DELETING")
        return failure$5("cache_deleting", "cache is being deleted", 410);
      this.ctx.storage.sql.exec(
        "UPDATE cache SET lifecycle = 'ACTIVE' WHERE lifecycle = 'CREATING'"
      );
      return { ok: true, value: toCache({ ...row, lifecycle: "ACTIVE" }) };
    });
  }
  async beginDelete() {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec("SELECT * FROM cache LIMIT 1")
      ][0];
      if (!row) return failure$5("not_found", "cache not found", 404);
      if (String(row.lifecycle) !== "DELETING")
        this.ctx.storage.sql.exec("UPDATE cache SET lifecycle = 'DELETING'");
      return { ok: true, value: toCache({ ...row, lifecycle: "DELETING" }) };
    });
  }
  async remove() {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec(
          "SELECT lifecycle FROM cache LIMIT 1"
        )
      ][0];
      if (!row) return { ok: true, value: void 0 };
      if (row.lifecycle !== "DELETING")
        return failure$5(
          "cache_not_deleting",
          "cache must be deleting before removal",
          409
        );
      const pendingAudit = [
        ...this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count FROM audit_outbox"
        )
      ][0];
      if (pendingAudit && Number(pendingAudit.count) > 0)
        return failure$5(
          "audit_pending",
          "cache audit events must be delivered before removal",
          503
        );
      this.ctx.storage.sql.exec(
        "DELETE FROM audit_outbox; DELETE FROM clear_operations; DELETE FROM quota_operations; DELETE FROM upload_allocations; DELETE FROM cache;"
      );
      return { ok: true, value: void 0 };
    });
  }
}
class CoordinatorUploads {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  ctx;
  env;
  async allocate(input) {
    return this.ctx.storage.transactionSync(() => {
      const cache2 = [
        ...this.ctx.storage.sql.exec(
          "SELECT lifecycle FROM cache LIMIT 1"
        )
      ][0];
      if (!cache2) return failure$5("not_found", "cache not found", 404);
      if (cache2.lifecycle !== "ACTIVE")
        return failure$5(
          cache2.lifecycle === "DELETING" ? "cache_deleting" : "cache_unavailable",
          "cache is not active",
          cache2.lifecycle === "DELETING" ? 410 : 503
        );
      const old = [
        ...this.ctx.storage.sql.exec(
          "SELECT fingerprint, upload_id, staging_key FROM upload_allocations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (old) {
        if (String(old.fingerprint) !== input.fingerprint)
          return failure$5(
            "idempotency_conflict",
            "idempotency key was reused with different upload metadata",
            409
          );
        return {
          ok: true,
          value: {
            id: String(old.upload_id),
            staging_key: String(old.staging_key),
            repeated: true
          }
        };
      }
      const id = this.env.UPLOAD_JOB.newUniqueId().toString();
      const stagingKey = `staging/${id}.nar.zst`;
      this.ctx.storage.sql.exec(
        "INSERT INTO upload_allocations (operation_id, fingerprint, upload_id, staging_key) VALUES (?, ?, ?, ?)",
        input.operation_id,
        input.fingerprint,
        id,
        stagingKey
      );
      return {
        ok: true,
        value: { id, staging_key: stagingKey, repeated: false }
      };
    });
  }
}
const schema$2 = `CREATE TABLE IF NOT EXISTS cache (
  cache_id TEXT PRIMARY KEY, name TEXT NOT NULL, incarnation TEXT NOT NULL,
  public INTEGER NOT NULL, quota_bytes INTEGER NOT NULL, logical_bytes INTEGER NOT NULL DEFAULT 0,
  encoding_id TEXT NOT NULL, created_at INTEGER NOT NULL, lifecycle TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_operations (
  operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_allocations (
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE, staging_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clear_operations (
  operation_id TEXT PRIMARY KEY, delta INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_outbox (
  event_id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL
);`;
class CacheCoordinator extends DurableObject {
  state;
  uploads;
  quota;
  audit;
  constructor(ctx, env) {
    super(ctx, env);
    initialize(ctx, schema$2);
    this.state = new CoordinatorState(ctx);
    this.uploads = new CoordinatorUploads(ctx, env);
    this.quota = new CoordinatorQuota(ctx);
    this.audit = new CoordinatorAudit(ctx, env);
  }
  initialize(input) {
    return this.state.initialize(input);
  }
  getCache() {
    return this.state.getCache();
  }
  configure(input) {
    return this.state.configure(input);
  }
  activate() {
    return this.state.activate();
  }
  beginDelete() {
    return this.state.beginDelete();
  }
  remove() {
    return this.state.remove();
  }
  allocateUpload(input) {
    return this.uploads.allocate(input);
  }
  reserve(input) {
    return this.quota.reserve(input);
  }
  finalize(input) {
    return this.quota.finalize(input);
  }
  abort(input) {
    return this.quota.abort(input);
  }
  reconcile(input) {
    return this.quota.reconcile(input);
  }
  clearDelta(input) {
    return this.quota.clearDelta(input);
  }
  recordAudit(event2) {
    return this.audit.record(event2);
  }
  flushAudit() {
    return this.audit.flush();
  }
  shardId(prefix) {
    return this.audit.shardId(prefix);
  }
  alarm() {
    return this.audit.alarm();
  }
  fetch() {
    return Response.json({ code: "rpc_only" }, { status: 404 });
  }
}
const failure$4 = (code, message2, status) => ({ ok: false, error: { code, message: message2, status } });
class CacheIndexShard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initialize(
      ctx,
      `CREATE TABLE IF NOT EXISTS paths (
      store_hash TEXT PRIMARY KEY, record TEXT NOT NULL, file_size INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS paths_lru ON paths(last_accessed);
    CREATE TABLE IF NOT EXISTS index_operations (
      operation_id TEXT PRIMARY KEY, store_hash TEXT, mutation TEXT NOT NULL,
      previous TEXT, next_record TEXT, delta INTEGER NOT NULL, status TEXT NOT NULL,
      clear_deleted INTEGER NOT NULL DEFAULT 0, clear_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS index_store_lock ON index_operations(store_hash) WHERE status = 'PREPARED';
    CREATE TABLE IF NOT EXISTS deletion_fence (
      key INTEGER PRIMARY KEY CHECK (key = 1), operation_id TEXT NOT NULL
    );`
    );
  }
  async lookup(storeHash) {
    const row = [
      ...this.ctx.storage.sql.exec(
        "SELECT record FROM paths WHERE store_hash = ?",
        storeHash
      )
    ][0];
    return row ? { ok: true, value: JSON.parse(row.record) } : failure$4("not_found", "path not found", 404);
  }
  async prepare(input) {
    return this.ctx.storage.transactionSync(() => {
      const mutationJson = JSON.stringify(input.mutation);
      const existing = [
        ...this.ctx.storage.sql.exec(
          "SELECT operation_id, mutation, previous, next_record, delta, status FROM index_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (existing) {
        if (String(existing.mutation) !== mutationJson)
          return failure$4(
            "operation_conflict",
            "index mutation changed during retry",
            409
          );
        return { ok: true, value: toPrepared(existing) };
      }
      const fenced = [
        ...this.ctx.storage.sql.exec(
          "SELECT operation_id FROM deletion_fence WHERE key = 1"
        )
      ][0];
      if (fenced)
        return failure$4(
          "cache_deleting",
          "cache index is fenced for deletion",
          410
        );
      const storeHash = input.mutation.kind === "upsert" ? input.mutation.record.store_hash : input.mutation.store_hash;
      const previousRow = storeHash ? [
        ...this.ctx.storage.sql.exec(
          "SELECT record FROM paths WHERE store_hash = ?",
          storeHash
        )
      ][0] : null;
      const previous = previousRow ? JSON.parse(previousRow.record) : null;
      const next = input.mutation.kind === "upsert" ? input.mutation.record : null;
      const delta = input.mutation.kind === "upsert" ? deltaFor(next, previous) : deltaFor(null, previous);
      if (storeHash) {
        const lock = [
          ...this.ctx.storage.sql.exec(
            "SELECT operation_id FROM index_operations WHERE store_hash = ? AND status = 'PREPARED'",
            storeHash
          )
        ][0];
        if (lock && lock.operation_id !== input.operation_id)
          return failure$4(
            "mutation_in_progress",
            "another mutation is in progress for this path",
            409
          );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO index_operations (operation_id, store_hash, mutation, previous, next_record, delta, status) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED')",
        input.operation_id,
        storeHash,
        mutationJson,
        previous ? JSON.stringify(previous) : null,
        next ? JSON.stringify(next) : null,
        delta
      );
      return {
        ok: true,
        value: {
          operation_id: input.operation_id,
          delta,
          previous,
          record: next,
          status: "PREPARED"
        }
      };
    });
  }
  async commit(operationId) {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec(
          "SELECT * FROM index_operations WHERE operation_id = ?",
          operationId
        )
      ][0];
      if (!row)
        return failure$4("operation_not_found", "index operation not found", 404);
      if (row.status === "COMMITTED")
        return { ok: true, value: toPrepared(row) };
      if (row.status === "ABORTED")
        return failure$4("operation_aborted", "index operation was aborted", 409);
      const fenced = [
        ...this.ctx.storage.sql.exec(
          "SELECT operation_id FROM deletion_fence WHERE key = 1"
        )
      ][0];
      if (fenced) {
        this.ctx.storage.sql.exec(
          "UPDATE index_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'PREPARED'",
          operationId
        );
        return failure$4(
          "cache_deleting",
          "cache index is fenced for deletion",
          410
        );
      }
      const mutation = JSON.parse(String(row.mutation));
      if (mutation.kind === "upsert")
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO paths (store_hash, record, file_size, last_accessed, created_at) VALUES (?, ?, ?, ?, ?)",
          mutation.record.store_hash,
          JSON.stringify(mutation.record),
          mutation.record.file_size,
          mutation.record.last_accessed,
          mutation.record.created_at
        );
      else
        this.ctx.storage.sql.exec(
          "DELETE FROM paths WHERE store_hash = ?",
          mutation.store_hash
        );
      this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'COMMITTED' WHERE operation_id = ? AND status = 'PREPARED'",
        operationId
      );
      return { ok: true, value: toPrepared({ ...row, status: "COMMITTED" }) };
    });
  }
  async abort(operationId) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'ABORTED' WHERE operation_id = ? AND status = 'PREPARED'",
        operationId
      )
    );
    return { ok: true, value: void 0 };
  }
  async clear(operationId) {
    return this.ctx.storage.transactionSync(() => {
      const old = [
        ...this.ctx.storage.sql.exec(
          "SELECT clear_deleted, clear_bytes, status FROM index_operations WHERE operation_id = ?",
          operationId
        )
      ][0];
      if (old)
        return {
          ok: true,
          value: {
            deleted: Number(old.clear_deleted),
            bytes: Number(old.clear_bytes),
            reconcile_operation_ids: this.committedOperationIds()
          }
        };
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO deletion_fence (key, operation_id) VALUES (1, ?)",
        operationId
      );
      this.ctx.storage.sql.exec(
        "UPDATE index_operations SET status = 'ABORTED' WHERE status = 'PREPARED'"
      );
      const totals = [
        ...this.ctx.storage.sql.exec(
          "SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM paths"
        )
      ][0];
      this.ctx.storage.sql.exec("DELETE FROM paths");
      this.ctx.storage.sql.exec(
        "INSERT INTO index_operations (operation_id, mutation, delta, status, clear_deleted, clear_bytes) VALUES (?, ?, ?, 'COMMITTED', ?, ?)",
        operationId,
        JSON.stringify({ kind: "clear" }),
        -Number(totals?.bytes ?? 0),
        Number(totals?.count ?? 0),
        Number(totals?.bytes ?? 0)
      );
      return {
        ok: true,
        value: {
          deleted: Number(totals?.count ?? 0),
          bytes: Number(totals?.bytes ?? 0),
          reconcile_operation_ids: this.committedOperationIds()
        }
      };
    });
  }
  /**
   * Index commits and quota finalization are separate durable operations.
   * Teardown must finalize committed publications before debiting the shard.
   * Returning historical IDs is safe because quota finalization is idempotent.
   */
  committedOperationIds() {
    return [
      ...this.ctx.storage.sql.exec(
        "SELECT operation_id FROM index_operations WHERE status = 'COMMITTED' AND store_hash IS NOT NULL"
      )
    ].map((row) => String(row.operation_id));
  }
  async touch(storeHash) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "UPDATE paths SET last_accessed = ? WHERE store_hash = ?",
        now(),
        storeHash
      )
    );
    return { ok: true, value: void 0 };
  }
  fetch() {
    return Response.json({ code: "rpc_only" }, { status: 404 });
  }
}
function toPrepared(row) {
  return {
    operation_id: String(row.operation_id),
    delta: Number(row.delta),
    previous: row.previous ? JSON.parse(String(row.previous)) : null,
    record: row.next_record ? JSON.parse(String(row.next_record)) : null,
    status: String(row.status)
  };
}
const failure$3 = (code, message2, status) => ({ ok: false, error: { code, message: message2, status } });
class SystemControl extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initialize(
      ctx,
      `CREATE TABLE IF NOT EXISTS caches (
      cache_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, incarnation TEXT UNIQUE NOT NULL,
      coordinator_id TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, lifecycle TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS create_operations (
      operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, cache_id TEXT NOT NULL,
      FOREIGN KEY (cache_id) REFERENCES caches(cache_id)
    );
    CREATE TABLE IF NOT EXISTS cache_creation_config (
      cache_id TEXT PRIMARY KEY, public INTEGER NOT NULL,
      quota_bytes INTEGER NOT NULL, encoding_id TEXT NOT NULL,
      FOREIGN KEY (cache_id) REFERENCES caches(cache_id)
    );
    CREATE TABLE IF NOT EXISTS delete_operations (
      cache_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL,
      FOREIGN KEY (cache_id) REFERENCES caches(cache_id)
    );`
    );
  }
  async createCache(input) {
    return this.ctx.storage.transactionSync(() => {
      const oldOperation = [
        ...this.ctx.storage.sql.exec(
          "SELECT fingerprint, cache_id FROM create_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (oldOperation) {
        if (String(oldOperation.fingerprint) !== input.fingerprint)
          return failure$3(
            "idempotency_conflict",
            "idempotency key was reused with different cache configuration",
            409
          );
        const row = [
          ...this.ctx.storage.sql.exec(
            "SELECT cache_id, name, incarnation, coordinator_id FROM caches WHERE cache_id = ?",
            oldOperation.cache_id
          )
        ][0];
        return row ? { ok: true, value: { reference: reference(row), repeated: true } } : failure$3(
          "operation_not_found",
          "cache creation record is missing",
          503
        );
      }
      const existing = [
        ...this.ctx.storage.sql.exec(
          "SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name = ?",
          input.name
        )
      ][0];
      if (existing) {
        if (String(existing.lifecycle) === "CREATING") {
          const config = [
            ...this.ctx.storage.sql.exec(
              "SELECT public, quota_bytes, encoding_id FROM cache_creation_config WHERE cache_id = ?",
              existing.cache_id
            )
          ][0];
          if (config && (Number(config.public) !== (input.public ? 1 : 0) || Number(config.quota_bytes) !== input.quota_bytes || String(config.encoding_id) !== input.encoding_id))
            return failure$3(
              "cache_creation_conflict",
              "cache creation is already in progress with different configuration",
              409
            );
          return {
            ok: true,
            value: { reference: reference(existing), repeated: true }
          };
        }
        return failure$3("cache_exists", "cache name is already registered", 409);
      }
      const value = {
        id: crypto.randomUUID(),
        name: input.name,
        incarnation: crypto.randomUUID(),
        coordinator_id: this.env.CACHE_COORDINATOR.newUniqueId().toString()
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO caches (cache_id, name, incarnation, coordinator_id, created_at, lifecycle) VALUES (?, ?, ?, ?, ?, 'CREATING')",
        value.id,
        value.name,
        value.incarnation,
        value.coordinator_id,
        now()
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO create_operations (operation_id, fingerprint, cache_id) VALUES (?, ?, ?)",
        input.operation_id,
        input.fingerprint,
        value.id
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO cache_creation_config (cache_id, public, quota_bytes, encoding_id) VALUES (?, ?, ?, ?)",
        value.id,
        input.public ? 1 : 0,
        input.quota_bytes,
        input.encoding_id
      );
      return { ok: true, value: { reference: value, repeated: false } };
    });
  }
  async getCache(name) {
    const row = [
      ...this.ctx.storage.sql.exec(
        "SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name = ?",
        name
      )
    ][0];
    return row ? { ok: true, value: reference(row) } : failure$3("not_found", "cache not found", 404);
  }
  async activateCache(value) {
    const result = this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec(
        "UPDATE caches SET lifecycle = 'ACTIVE' WHERE cache_id = ? AND incarnation = ? AND lifecycle = 'CREATING'",
        value.id,
        value.incarnation
      ).rowsWritten;
      const row = [
        ...this.ctx.storage.sql.exec(
          "SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?",
          value.id,
          value.incarnation
        )
      ][0];
      if (!row) return failure$3("not_found", "cache not found", 404);
      if (row.lifecycle !== "ACTIVE" && changed === 0)
        return failure$3(
          "cache_unavailable",
          "cache could not be activated",
          503
        );
      return { ok: true, value: void 0 };
    });
    return result;
  }
  async beginDelete(input) {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec(
          "SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?",
          input.reference.id,
          input.reference.incarnation
        )
      ][0];
      if (!row) return failure$3("not_found", "cache not found", 404);
      const operationOnCache = [
        ...this.ctx.storage.sql.exec(
          "SELECT cache_id FROM delete_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (operationOnCache && String(operationOnCache.cache_id) !== input.reference.id)
        return failure$3(
          "idempotency_conflict",
          "idempotency key is already assigned to another cache deletion",
          409
        );
      const existing = [
        ...this.ctx.storage.sql.exec(
          "SELECT operation_id FROM delete_operations WHERE cache_id = ?",
          input.reference.id
        )
      ][0];
      if (existing)
        return {
          ok: true,
          value: {
            operation_id: String(existing.operation_id),
            repeated: true
          }
        };
      this.ctx.storage.sql.exec(
        "UPDATE caches SET lifecycle = 'DELETING' WHERE cache_id = ? AND incarnation = ?",
        input.reference.id,
        input.reference.incarnation
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO delete_operations (cache_id, operation_id) VALUES (?, ?)",
        input.reference.id,
        input.operation_id
      );
      return {
        ok: true,
        value: { operation_id: input.operation_id, repeated: false }
      };
    });
  }
  async removeCache(value) {
    return this.ctx.storage.transactionSync(() => {
      const row = [
        ...this.ctx.storage.sql.exec(
          "SELECT lifecycle FROM caches WHERE cache_id = ? AND incarnation = ?",
          value.id,
          value.incarnation
        )
      ][0];
      if (!row) return { ok: true, value: void 0 };
      if (row.lifecycle !== "DELETING")
        return failure$3(
          "cache_not_deleting",
          "cache must be deleting before removal",
          409
        );
      this.ctx.storage.sql.exec(
        "DELETE FROM create_operations WHERE cache_id = ?",
        value.id
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM delete_operations WHERE cache_id = ?",
        value.id
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM cache_creation_config WHERE cache_id = ?",
        value.id
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM caches WHERE cache_id = ? AND incarnation = ?",
        value.id,
        value.incarnation
      );
      return { ok: true, value: void 0 };
    });
  }
  async listCaches(input) {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
    const rows = [
      ...this.ctx.storage.sql.exec(
        input.after ? "SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches WHERE name > ? ORDER BY name LIMIT ?" : "SELECT cache_id, name, incarnation, coordinator_id, lifecycle FROM caches ORDER BY name LIMIT ?",
        ...input.after ? [input.after, limit + 1] : [limit + 1]
      )
    ];
    const page = rows.slice(0, limit).map(reference);
    return {
      ok: true,
      value: {
        items: page,
        next_after: rows.length > limit ? page.at(-1)?.name ?? null : null
      }
    };
  }
  fetch() {
    return Response.json({ code: "rpc_only" }, { status: 404 });
  }
}
function reference(row) {
  return {
    id: String(row.cache_id),
    name: String(row.name),
    incarnation: String(row.incarnation),
    coordinator_id: String(row.coordinator_id),
    lifecycle: row.lifecycle ? String(row.lifecycle) : void 0
  };
}
class TokenAudit {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  ctx;
  env;
  enqueue(event2) {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO audit_outbox (event_id, event, created_at) VALUES (?, ?, ?)",
      event2.id,
      JSON.stringify(event2),
      now()
    );
    this.ctx.waitUntil(this.drain());
  }
  async alarm() {
    await this.drain();
  }
  async drain() {
    const rows = [
      ...this.ctx.storage.sql.exec(
        "SELECT event_id, event FROM audit_outbox ORDER BY created_at LIMIT 50"
      )
    ];
    if (!rows.length) return;
    for (const row of rows) {
      const event2 = JSON.parse(String(row.event));
      const result = await auditStub(this.env, event2.id).append(event2);
      if (!result.ok) {
        await this.ctx.storage.setAlarm(Date.now() + 3e4);
        return;
      }
      this.ctx.storage.transactionSync(
        () => this.ctx.storage.sql.exec(
          "DELETE FROM audit_outbox WHERE event_id = ?",
          row.event_id
        )
      );
    }
    const pending = [
      ...this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM audit_outbox"
      )
    ][0];
    if (pending && Number(pending.count) > 0)
      await this.ctx.storage.setAlarm(Date.now() + 1e3);
  }
}
const failure$2 = (code, message2, status) => ({ ok: false, error: { code, message: message2, status } });
const toTokenSummary = (row) => ({
  id: String(row.jti),
  subject: String(row.subject),
  expires_at: Number(row.expires_at),
  issued_at: Number(row.issued_at),
  grants: JSON.parse(String(row.grants)),
  revoked: Number(row.revoked) === 1
});
class TokenIssuance {
  constructor(ctx, env, signer, audit) {
    this.ctx = ctx;
    this.env = env;
    this.signer = signer;
    this.audit = audit;
  }
  ctx;
  env;
  signer;
  audit;
  async bootstrap(input) {
    if (!input.grants.length || !input.grants.every(validateGrant))
      return failure$2("invalid_input", "bootstrap grants are invalid", 422);
    if (await hashSecret(input.secret) !== this.env.BOOTSTRAP_SECRET_HASH)
      return failure$2("forbidden", "invalid bootstrap secret", 403);
    const operationId = `bootstrap:${input.operation_id}`;
    const existing = this.findOperation(operationId);
    if (existing) {
      if (String(existing.fingerprint) !== input.fingerprint)
        return failure$2(
          "idempotency_conflict",
          "idempotency key was reused with different token metadata",
          409
        );
      return {
        ok: true,
        value: {
          id: String(existing.jti),
          token: String(existing.token),
          expires_at: Number(existing.expires_at),
          repeated: true
        }
      };
    }
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at
    );
    return this.ctx.storage.transactionSync(() => {
      const operation = [
        ...this.ctx.storage.sql.exec(
          "SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?",
          operationId
        )
      ][0];
      if (operation) {
        if (String(operation.fingerprint) !== input.fingerprint)
          return failure$2(
            "idempotency_conflict",
            "idempotency key was reused with different token metadata",
            409
          );
        return {
          ok: true,
          value: {
            id: String(operation.jti),
            token: String(operation.token),
            expires_at: Number(operation.expires_at),
            repeated: true
          }
        };
      }
      const consumed = [
        ...this.ctx.storage.sql.exec("SELECT 1 FROM bootstrap WHERE key = 1")
      ][0];
      if (consumed)
        return failure$2(
          "bootstrap_consumed",
          "bootstrap has already been consumed",
          409
        );
      this.ctx.storage.sql.exec(
        "INSERT INTO tokens (jti, subject, expires_at, issued_at, grants, revoked, token, operation_id, fingerprint) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
        signed.jti,
        input.subject,
        input.expires_at,
        signed.issued_at,
        JSON.stringify(input.grants),
        signed.token,
        operationId,
        input.fingerprint
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO bootstrap (key, operation_id, fingerprint) VALUES (1, ?, ?)",
        input.operation_id,
        input.fingerprint
      );
      this.audit.enqueue({
        id: `bootstrap:${input.operation_id}`,
        timestamp: signed.issued_at,
        actor: input.subject,
        action: "bootstrap",
        resource: "system",
        outcome: "success",
        metadata: {}
      });
      return {
        ok: true,
        value: {
          id: signed.jti,
          token: signed.token,
          expires_at: input.expires_at,
          repeated: false
        }
      };
    });
  }
  async issue(input) {
    if (!input.grants.length || !input.grants.every(validateGrant))
      return failure$2("invalid_input", "token grants are invalid", 422);
    const existing = this.findOperation(input.operation_id);
    if (existing) {
      if (String(existing.fingerprint) !== input.fingerprint)
        return failure$2(
          "idempotency_conflict",
          "idempotency key was reused with different token metadata",
          409
        );
      return {
        ok: true,
        value: {
          id: String(existing.jti),
          token: String(existing.token),
          expires_at: Number(existing.expires_at),
          repeated: true
        }
      };
    }
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at
    );
    return this.ctx.storage.transactionSync(() => {
      const old = [
        ...this.ctx.storage.sql.exec(
          "SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (old) {
        if (String(old.fingerprint) !== input.fingerprint)
          return failure$2(
            "idempotency_conflict",
            "idempotency key was reused with different token metadata",
            409
          );
        return {
          ok: true,
          value: {
            id: String(old.jti),
            token: String(old.token),
            expires_at: Number(old.expires_at),
            repeated: true
          }
        };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO tokens (jti, subject, expires_at, issued_at, grants, revoked, token, operation_id, fingerprint) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
        signed.jti,
        input.subject,
        input.expires_at,
        signed.issued_at,
        JSON.stringify(input.grants),
        signed.token,
        input.operation_id,
        input.fingerprint
      );
      this.audit.enqueue({
        id: `token:${input.operation_id}`,
        timestamp: signed.issued_at,
        actor: input.actor,
        action: "token.issue",
        resource: signed.jti,
        outcome: "success",
        metadata: {}
      });
      return {
        ok: true,
        value: {
          id: signed.jti,
          token: signed.token,
          expires_at: input.expires_at,
          repeated: false
        }
      };
    });
  }
  findOperation(operationId) {
    return [
      ...this.ctx.storage.sql.exec(
        "SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?",
        operationId
      )
    ][0] ?? null;
  }
}
class TokenManagement {
  constructor(ctx, audit) {
    this.ctx = ctx;
    this.audit = audit;
  }
  ctx;
  audit;
  async check(input) {
    const row = [
      ...this.ctx.storage.sql.exec(
        "SELECT revoked, expires_at FROM tokens WHERE jti = ?",
        input.jti
      )
    ][0];
    return {
      ok: true,
      value: {
        active: Boolean(
          row && Number(row.revoked) === 0 && Number(row.expires_at) >= now() && Number(row.expires_at) === input.exp
        )
      }
    };
  }
  async revoke(input) {
    return this.ctx.storage.transactionSync(() => {
      const old = [
        ...this.ctx.storage.sql.exec(
          "SELECT jti FROM token_operations WHERE operation_id = ?",
          input.operation_id
        )
      ][0];
      if (old && old.jti !== input.jti)
        return failure$2(
          "idempotency_conflict",
          "revocation operation changed token",
          409
        );
      this.ctx.storage.sql.exec(
        "UPDATE tokens SET revoked = 1 WHERE jti = ?",
        input.jti
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO token_operations (operation_id, jti) VALUES (?, ?)",
        input.operation_id,
        input.jti
      );
      this.audit.enqueue({
        id: input.operation_id,
        timestamp: now(),
        actor: input.actor,
        action: "token.revoke",
        resource: input.jti,
        outcome: "success",
        metadata: {}
      });
      return { ok: true, value: void 0 };
    });
  }
  async list(input) {
    const cursor = decodeCursor(
      input.cursor
    );
    const rows = cursor ? [
      ...this.ctx.storage.sql.exec(
        "SELECT jti, subject, expires_at, issued_at, grants, revoked FROM tokens WHERE (issued_at < ? OR (issued_at = ? AND jti < ?)) ORDER BY issued_at DESC, jti DESC LIMIT ?",
        cursor.issued_at,
        cursor.issued_at,
        cursor.jti,
        input.limit + 1
      )
    ] : [
      ...this.ctx.storage.sql.exec(
        "SELECT jti, subject, expires_at, issued_at, grants, revoked FROM tokens ORDER BY issued_at DESC, jti DESC LIMIT ?",
        input.limit + 1
      )
    ];
    const items = rows.slice(0, input.limit).map(toTokenSummary);
    const last = rows.length > input.limit ? rows[input.limit - 1] : null;
    return {
      ok: true,
      value: {
        items,
        next_cursor: last ? btoa(
          JSON.stringify({
            issued_at: Number(last.issued_at),
            jti: String(last.jti)
          })
        ).replaceAll("=", "") : null
      }
    };
  }
}
class TokenSigner {
  constructor(env) {
    this.env = env;
  }
  env;
  async sign(subject, grants, expiresAt) {
    const issuedAt = now();
    const jti = crypto.randomUUID().replaceAll("-", "");
    const key = await importJWK(
      JSON.parse(this.env.AUTH_PRIVATE_JWK),
      "EdDSA"
    );
    const token = await new SignJWT({ grants }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "current" }).setIssuer(this.env.TOKEN_ISSUER).setAudience(this.env.TOKEN_AUDIENCE).setSubject(subject).setJti(jti).setIssuedAt(issuedAt).setNotBefore(issuedAt).setExpirationTime(expiresAt).sign(key);
    return { jti, token, issued_at: issuedAt };
  }
}
const schema$1 = `CREATE TABLE IF NOT EXISTS tokens (
  jti TEXT PRIMARY KEY, subject TEXT NOT NULL, expires_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, grants TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL, operation_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_operations (operation_id TEXT PRIMARY KEY, jti TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bootstrap (key INTEGER PRIMARY KEY CHECK (key = 1), operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_outbox (event_id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL);`;
class TokenCatalog extends DurableObject {
  issuance;
  management;
  audit;
  constructor(ctx, env) {
    super(ctx, env);
    initialize(ctx, schema$1);
    this.audit = new TokenAudit(ctx, env);
    this.issuance = new TokenIssuance(
      ctx,
      env,
      new TokenSigner(env),
      this.audit
    );
    this.management = new TokenManagement(ctx, this.audit);
  }
  bootstrap(input) {
    return this.issuance.bootstrap(input);
  }
  issue(input) {
    return this.issuance.issue(input);
  }
  check(input) {
    return this.management.check(input);
  }
  revoke(input) {
    return this.management.revoke(input);
  }
  list(input) {
    return this.management.list(input);
  }
  alarm() {
    return this.audit.alarm();
  }
  fetch() {
    return Response.json({ code: "rpc_only" }, { status: 404 });
  }
}
const failure$1 = (code, message2, status) => ({ ok: false, error: { code, message: message2, status } });
class AuditLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    initialize(
      ctx,
      `CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, resource TEXT NOT NULL, outcome TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_order ON audit(timestamp DESC, id DESC);`
    );
  }
  async append(event2) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO audit (id, timestamp, actor, action, resource, outcome, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
        event2.id,
        event2.timestamp,
        event2.actor,
        event2.action,
        event2.resource,
        event2.outcome,
        JSON.stringify(event2.metadata)
      )
    );
    return { ok: true, value: void 0 };
  }
  async list(input) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      return failure$1("invalid_limit", "limit must be between 1 and 100", 400);
    const cursor = decodeCursor(
      input.cursor
    );
    const rows = cursor ? [
      ...this.ctx.storage.sql.exec(
        "SELECT id, timestamp, actor, action, resource, outcome, metadata FROM audit WHERE (timestamp < ? OR (timestamp = ? AND id < ?)) ORDER BY timestamp DESC, id DESC LIMIT ?",
        cursor.timestamp,
        cursor.timestamp,
        cursor.id,
        input.limit + 1
      )
    ] : [
      ...this.ctx.storage.sql.exec(
        "SELECT id, timestamp, actor, action, resource, outcome, metadata FROM audit ORDER BY timestamp DESC, id DESC LIMIT ?",
        input.limit + 1
      )
    ];
    const items = rows.slice(0, input.limit).map((row) => ({
      id: String(row.id),
      timestamp: Number(row.timestamp),
      actor: String(row.actor),
      action: String(row.action),
      resource: String(row.resource),
      outcome: String(row.outcome),
      metadata: JSON.parse(String(row.metadata))
    }));
    const last = rows.length > input.limit ? rows[input.limit - 1] : null;
    return {
      ok: true,
      value: {
        items,
        next_cursor: last ? encode(
          JSON.stringify({
            timestamp: Number(last.timestamp),
            id: String(last.id)
          })
        ) : null
      }
    };
  }
  fetch() {
    return Response.json({ code: "rpc_only" }, { status: 404 });
  }
}
const failure = (code, message2, status) => ({ ok: false, error: { code, message: message2, status } });
const state = (row) => ({
  id: row.job_id,
  status: row.state,
  error: row.error
});
const processJob = (row) => ({
  job_id: row.job_id,
  staging_key: row.staging_key,
  nar_hash: row.manifest.nar_hash,
  nar_size: row.manifest.nar_size,
  encoding_id: ENCODING_ID
});
class UploadMultipart {
  constructor(ctx, env, storage) {
    this.ctx = ctx;
    this.env = env;
    this.storage = storage;
  }
  ctx;
  env;
  storage;
  async init(input) {
    const existing = this.storage.row();
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.idempotency_key !== input.idempotency_key)
        return failure(
          "idempotency_conflict",
          "upload metadata changed during retry",
          409
        );
      return {
        ok: true,
        value: { job_id: existing.job_id, state: existing.state }
      };
    }
    const upload = await this.env.CACHE_BUCKET.createMultipartUpload(
      input.staging_key,
      { httpMetadata: { contentType: "application/zstd" } }
    );
    const inserted = this.storage.insert({
      ...input,
      upload_id: upload.uploadId
    });
    if (!inserted) {
      await this.env.CACHE_BUCKET.resumeMultipartUpload(
        input.staging_key,
        upload.uploadId
      ).abort().catch(() => void 0);
      const row = this.storage.row();
      return row ? { ok: true, value: { job_id: row.job_id, state: row.state } } : failure("operation_not_found", "upload allocation disappeared", 503);
    }
    return { ok: true, value: { job_id: input.job_id, state: "UPLOADING" } };
  }
  async putPart(input) {
    const row = this.storage.row();
    if (!row?.upload_id || row.state !== "UPLOADING")
      return failure("not_uploadable", "upload is not accepting parts", 409);
    if (!Number.isSafeInteger(input.number) || input.number < 1 || input.number > partsFor(row.compressed_size, MULTIPART_PART_SIZE))
      return failure("invalid_part", "invalid multipart part number", 400);
    if (row.parts[input.number])
      return {
        ok: true,
        value: { part_number: input.number, etag: row.parts[input.number] }
      };
    const upload = this.env.CACHE_BUCKET.resumeMultipartUpload(
      row.staging_key,
      row.upload_id
    );
    let part;
    if (input.body) {
      const fixed = new FixedLengthStream(input.length);
      const uploadPart = upload.uploadPart(input.number, fixed.readable);
      [part] = await Promise.all([
        uploadPart,
        input.body.pipeTo(fixed.writable)
      ]);
    } else {
      if (input.length !== 0)
        return failure("invalid_part", "part body length does not match", 400);
      part = await upload.uploadPart(input.number, new Uint8Array());
    }
    const current = this.storage.row();
    if (current && !current.parts[input.number])
      this.storage.setParts(current.job_id, {
        ...current.parts,
        [input.number]: part.etag
      });
    return { ok: true, value: { part_number: input.number, etag: part.etag } };
  }
  async complete(input) {
    const supplied = parseJsonSchema(CompleteUploadSchema, input);
    const row = this.storage.row();
    if (!row?.upload_id)
      return row ? failure("not_uploadable", "upload is not multipart active", 409) : failure("not_found", "upload not found", 404);
    if (["QUEUED", "PROCESSING", "PUBLISHING"].includes(row.state)) {
      await ensureWorkflow(
        this.env.PROCESS_UPLOAD,
        row.job_id,
        processJob(row)
      );
      return { ok: true, value: state(this.storage.row()) };
    }
    if (row.state === "READY") return { ok: true, value: state(row) };
    if (row.state !== "UPLOADING" && row.state !== "COMPLETING")
      return { ok: true, value: state(row) };
    if (row.state === "COMPLETING") return this.completeMultipart(row);
    const values = supplied.parts?.length ? supplied.parts : Object.entries(row.parts).map(([part_number, etag]) => ({
      part_number: Number(part_number),
      etag
    }));
    if (!values.length)
      return failure("missing_parts", "no uploaded parts were supplied", 400);
    const storedParts = Object.fromEntries(
      values.map((part) => [part.part_number, part.etag])
    );
    this.storage.setCompleting(row.job_id, storedParts);
    return this.completeMultipart(this.storage.row());
  }
  async completeMultipart(row) {
    const completed = await this.env.CACHE_BUCKET.head(row.staging_key);
    if (!completed) {
      if (!row.upload_id)
        return failure("not_uploadable", "upload is not multipart active", 409);
      const parts = Object.entries(row.parts).map(([part_number, etag]) => ({
        partNumber: Number(part_number),
        etag
      }));
      if (!parts.length)
        return failure("missing_parts", "no uploaded parts were supplied", 400);
      await this.env.CACHE_BUCKET.resumeMultipartUpload(
        row.staging_key,
        row.upload_id
      ).complete(parts);
    }
    return this.finishCompletion(this.storage.row());
  }
  async finishCompletion(row) {
    const completed = await this.env.CACHE_BUCKET.head(row.staging_key);
    if (!completed)
      return failure(
        "completion_pending",
        "multipart completion is not yet visible",
        503
      );
    if (completed.size !== row.compressed_size)
      return this.failSize(row, completed.size);
    this.storage.setQueued(row.job_id);
    await ensureWorkflow(this.env.PROCESS_UPLOAD, row.job_id, {
      job_id: row.job_id,
      staging_key: row.staging_key,
      nar_hash: row.manifest.nar_hash,
      nar_size: row.manifest.nar_size,
      encoding_id: ENCODING_ID
    });
    return { ok: true, value: state(this.storage.row()) };
  }
  async failSize(row, size) {
    this.storage.setError(
      row.job_id,
      `completed object size ${size} does not match declared size ${row.compressed_size}`
    );
    await this.env.CACHE_BUCKET.delete(row.staging_key);
    return { ok: true, value: state(this.storage.row()) };
  }
}
const encoder = new TextEncoder();
function standardBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
async function renderNarInfo(env, record, manifest) {
  const references = record.references.join(" ");
  const fingerprint = `1;${record.store_path};${record.nar_hash};${record.nar_size};${record.references.map((reference2) => reference2.startsWith("/") ? reference2 : `/nix/store/${reference2}`).join(",")}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.NIX_PRIVATE_JWK),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    encoder.encode(fingerprint)
  );
  const lines = [
    `StorePath: ${record.store_path}`,
    `URL: nar/${record.store_hash}.nar.zst`,
    "Compression: zstd",
    `FileHash: ${manifest.file_hash}`,
    `FileSize: ${manifest.file_size}`,
    `NarHash: ${record.nar_hash}`,
    `NarSize: ${record.nar_size}`,
    `References: ${references}`,
    `Sig: ${env.NIX_SIGNING_KEY_NAME}:${standardBase64(signature)}`
  ];
  if (record.deriver) lines.push(`Deriver: ${record.deriver}`);
  if (record.ca) lines.push(`CA: ${record.ca}`);
  return `${lines.join("\n")}
`;
}
class UploadPublication {
  constructor(ctx, env, storage) {
    this.ctx = ctx;
    this.env = env;
    this.storage = storage;
  }
  ctx;
  env;
  storage;
  async processing() {
    return this.ctx.storage.transactionSync(() => {
      const row = this.storage.row();
      if (!row) return failure("not_found", "upload not found", 404);
      if (["READY", "PROCESSING", "PUBLISHING"].includes(row.state))
        return { ok: true, value: void 0 };
      if (row.state !== "QUEUED")
        return failure(
          "invalid_transition",
          "upload is not queued for processing",
          409
        );
      transition(row.state, "PROCESSING");
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'PROCESSING' WHERE job_id = ?",
        row.job_id
      );
      return { ok: true, value: void 0 };
    });
  }
  async publish(result) {
    const row = this.storage.row();
    if (!row) return failure("not_found", "upload not found", 404);
    if (row.state === "READY") return { ok: true, value: void 0 };
    if (!["PROCESSING", "PUBLISHING"].includes(row.state))
      return failure(
        "invalid_transition",
        "upload is not ready for publication",
        409
      );
    const cache2 = await getCache(this.env, row.cache);
    if (cache2.reference.id !== row.cache_id || cache2.reference.incarnation !== row.incarnation)
      return failure(
        "cache_recreated",
        "upload belongs to an older cache incarnation",
        409
      );
    const manifestObject = await this.env.CACHE_BUCKET.get(result.manifest_key);
    if (!manifestObject)
      return failure(
        "publication_result_missing",
        "processor manifest is missing",
        503
      );
    let manifest;
    try {
      manifest = parseJsonSchema(
        ChunkManifestSchema,
        await manifestObject.json()
      );
    } catch {
      return failure("invalid_input", "processor manifest is invalid", 422);
    }
    if (manifest.nar_hash !== row.manifest.nar_hash || manifest.nar_size !== row.manifest.nar_size)
      return failure(
        "invalid_input",
        "processor manifest does not match upload metadata",
        422
      );
    this.storage.setResult(
      row.job_id,
      {
        manifest_key: result.manifest_key,
        deduplicated: result.deduplicated
      },
      ["PROCESSING", "PUBLISHING"],
      "PUBLISHING"
    );
    const record = {
      cache: row.cache,
      store_hash: row.manifest.store_hash,
      store_path: row.manifest.store_path,
      nar_hash: row.manifest.nar_hash,
      nar_size: row.manifest.nar_size,
      references: row.manifest.references,
      deriver: row.manifest.deriver,
      ca: row.manifest.ca,
      manifest_key: result.manifest_key,
      narinfo: "",
      file_hash: manifest.file_hash,
      file_size: manifest.file_size,
      last_accessed: now(),
      created_at: now()
    };
    record.narinfo = await renderNarInfo(this.env, record, manifest);
    try {
      await publicationFor(this.env, cache2, row.manifest.store_hash).execute(
        `publish:${row.job_id}`,
        { kind: "upsert", record }
      );
    } catch (error) {
      if (error instanceof PublicationError)
        return failure(
          "publication_failed",
          error.message,
          error.retryable ? 503 : 409
        );
      throw error;
    }
    this.storage.setState(row.job_id, ["PUBLISHING"], "READY");
    await this.env.CACHE_BUCKET.delete(row.staging_key);
    return { ok: true, value: void 0 };
  }
  async fail(message2, terminal = true) {
    if (!terminal) return { ok: true, value: void 0 };
    this.ctx.storage.transactionSync(() => {
      const row = this.storage.row();
      if (!row || ["READY", "ABORTED"].includes(row.state)) return;
      this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'FAILED', error = ? WHERE job_id = ?",
        message2.slice(0, 2e3),
        row.job_id
      );
    });
    return { ok: true, value: void 0 };
  }
  async abort() {
    const row = this.storage.row();
    if (!row) return failure("not_found", "upload not found", 404);
    if (row.state === "PROCESSING" || row.state === "PUBLISHING")
      return failure(
        "invalid_transition",
        "upload cannot be aborted after processing has started",
        409
      );
    if (row.upload_id && ["UPLOADING", "COMPLETING"].includes(row.state))
      await this.env.CACHE_BUCKET.resumeMultipartUpload(
        row.staging_key,
        row.upload_id
      ).abort().catch(() => void 0);
    this.ctx.storage.transactionSync(() => {
      const current = this.storage.row();
      if (current && !["READY", "FAILED", "ABORTED"].includes(current.state))
        this.ctx.storage.sql.exec(
          "UPDATE job SET state = 'ABORTED' WHERE job_id = ?",
          current.job_id
        );
    });
    return { ok: true, value: state(this.storage.row()) };
  }
  async state() {
    const row = this.storage.row();
    if (!row) return failure("not_found", "upload not found", 404);
    if (["QUEUED", "PROCESSING", "PUBLISHING"].includes(row.state))
      await ensureWorkflow(
        this.env.PROCESS_UPLOAD,
        row.job_id,
        processJob(row)
      );
    return { ok: true, value: state(this.storage.row()) };
  }
}
const schema = `CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY, cache TEXT NOT NULL, cache_id TEXT NOT NULL, incarnation TEXT NOT NULL,
  staging_key TEXT NOT NULL, upload_id TEXT, state TEXT NOT NULL, manifest TEXT NOT NULL,
  compressed_size INTEGER NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  parts TEXT NOT NULL, error TEXT, result TEXT
);`;
class UploadStorage {
  constructor(ctx) {
    this.ctx = ctx;
    initialize(ctx, schema);
  }
  ctx;
  row() {
    const row = [
      ...this.ctx.storage.sql.exec(
        "SELECT job_id, cache, cache_id, incarnation, staging_key, upload_id, state, manifest, compressed_size, idempotency_key, fingerprint, parts, error, result FROM job LIMIT 1"
      )
    ][0];
    if (!row) return null;
    return {
      job_id: String(row.job_id),
      cache: String(row.cache),
      cache_id: String(row.cache_id),
      incarnation: String(row.incarnation),
      staging_key: String(row.staging_key),
      upload_id: row.upload_id ? String(row.upload_id) : null,
      state: String(row.state),
      manifest: JSON.parse(String(row.manifest)),
      compressed_size: Number(row.compressed_size),
      idempotency_key: String(row.idempotency_key),
      fingerprint: String(row.fingerprint),
      parts: JSON.parse(String(row.parts)),
      error: row.error ? String(row.error) : null,
      result: row.result ? JSON.parse(String(row.result)) : null
    };
  }
  insert(input) {
    return this.ctx.storage.transactionSync(() => {
      if (this.row()) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO job (job_id, cache, cache_id, incarnation, staging_key, upload_id, state, manifest, compressed_size, idempotency_key, fingerprint, parts) VALUES (?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?, ?, ?)",
        input.job_id,
        input.cache,
        input.cache_id,
        input.incarnation,
        input.staging_key,
        input.upload_id,
        JSON.stringify(input.manifest),
        input.compressed_size,
        input.idempotency_key,
        input.fingerprint,
        "{}"
      );
      return true;
    });
  }
  setParts(jobId, parts) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "UPDATE job SET parts = ? WHERE job_id = ?",
        JSON.stringify(parts),
        jobId
      )
    );
  }
  setCompleting(jobId, parts) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'COMPLETING', parts = ? WHERE job_id = ? AND state = 'UPLOADING'",
        JSON.stringify(parts),
        jobId
      )
    );
  }
  setQueued(jobId) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "UPDATE job SET state = 'QUEUED' WHERE job_id = ? AND state = 'COMPLETING'",
        jobId
      )
    );
  }
  setState(jobId, from, to) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        `UPDATE job SET state = ? WHERE job_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
        to,
        jobId,
        ...from
      )
    );
  }
  setResult(jobId, result, from, to) {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        `UPDATE job SET state = ?, result = ? WHERE job_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
        to,
        JSON.stringify(result),
        jobId,
        ...from
      )
    );
  }
  setError(jobId, message2, to = "FAILED") {
    this.ctx.storage.transactionSync(
      () => this.ctx.storage.sql.exec(
        "UPDATE job SET state = ?, error = ? WHERE job_id = ?",
        to,
        message2.slice(0, 2e3),
        jobId
      )
    );
  }
}
class UploadJob extends DurableObject {
  storage;
  multipart;
  publication;
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = new UploadStorage(ctx);
    this.multipart = new UploadMultipart(ctx, env, this.storage);
    this.publication = new UploadPublication(ctx, env, this.storage);
  }
  async access() {
    const row = this.storage.row();
    return row ? { ok: true, value: { cache: row.cache, state: row.state } } : failure("not_found", "upload not found", 404);
  }
  init(input) {
    return this.multipart.init(input);
  }
  putPart(input) {
    return this.multipart.putPart(input);
  }
  complete(input) {
    return this.multipart.complete(input);
  }
  processing() {
    return this.publication.processing();
  }
  publish(result) {
    return this.publication.publish(result);
  }
  fail(message2, terminal = true) {
    return this.publication.fail(message2, terminal);
  }
  abort() {
    return this.publication.abort();
  }
  state() {
    return this.publication.state();
  }
  fetch() {
    return Response.json({ code: "rpc_only" }, { status: 404 });
  }
}
function generateId(length = 9) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += alphabet[bytes[i] % alphabet.length];
  }
  return result;
}
function parseTimeExpression(timeExpression) {
  if (typeof timeExpression === "number") {
    return timeExpression;
  }
  if (typeof timeExpression === "string") {
    const match2 = timeExpression.match(/^(\d+)([smh])$/);
    if (!match2) {
      throw new Error(`invalid time expression ${timeExpression}`);
    }
    const value = parseInt(match2[1]);
    const unit = match2[2];
    switch (unit) {
      case "s":
        return value;
      case "m":
        return value * 60;
      case "h":
        return value * 60 * 60;
      default:
        throw new Error(`unknown time unit ${unit}`);
    }
  }
  throw new Error(`invalid type for a time expression: ${typeof timeExpression}`);
}
const NO_CONTAINER_INSTANCE_ERROR = "there is no container instance that can be provided to this durable object";
const RATE_LIMITED_ERROR = "you are requesting too many containers per second";
const RUNTIME_SIGNALLED_ERROR = "runtime signalled the container to exit:";
const UNEXPECTED_EXIT_ERROR = "container exited with unexpected exit code:";
const NOT_LISTENING_ERROR = "the container is not listening";
const CONTAINER_STATE_KEY = "__CF_CONTAINER_STATE";
const OUTBOUND_CONFIGURATION_KEY = "OUTBOUND_CONFIGURATION";
const MAX_ALARM_RETRIES = 3;
const PING_TIMEOUT_MS = 5e3;
const DEFAULT_SLEEP_AFTER = "10m";
const INSTANCE_POLL_INTERVAL_MS = 300;
const TIMEOUT_TO_GET_CONTAINER_MS = 8e3;
const TIMEOUT_TO_GET_PORTS_MS = 2e4;
const FALLBACK_PORT_TO_CHECK = 33;
const outboundHandlersRegistry = /* @__PURE__ */ new Map();
const defaultOutboundHandlerNameRegistry = /* @__PURE__ */ new Map();
const outboundByHostRegistry = /* @__PURE__ */ new Map();
const signalToNumbers = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9
};
function isErrorOfType(e, matchingString) {
  const errorString = e instanceof Error ? e.message : String(e);
  return errorString.toLowerCase().includes(matchingString);
}
const isNoInstanceError = (error) => isErrorOfType(error, NO_CONTAINER_INSTANCE_ERROR);
const isRateLimitedError = (error) => isErrorOfType(error, RATE_LIMITED_ERROR);
const isRuntimeSignalledError = (error) => isErrorOfType(error, RUNTIME_SIGNALLED_ERROR);
const isNotListeningError = (error) => isErrorOfType(error, NOT_LISTENING_ERROR);
const isContainerExitNonZeroError = (error) => isErrorOfType(error, UNEXPECTED_EXIT_ERROR);
function getExitCodeFromError(error) {
  if (!(error instanceof Error)) {
    return null;
  }
  if (isRuntimeSignalledError(error)) {
    return +error.message.toLowerCase().slice(error.message.toLowerCase().indexOf(RUNTIME_SIGNALLED_ERROR) + RUNTIME_SIGNALLED_ERROR.length + 1);
  }
  if (isContainerExitNonZeroError(error)) {
    return +error.message.toLowerCase().slice(error.message.toLowerCase().indexOf(UNEXPECTED_EXIT_ERROR) + UNEXPECTED_EXIT_ERROR.length + 1);
  }
  return null;
}
function addTimeoutSignal(existingSignal, timeoutMs) {
  const controller = new AbortController();
  if (existingSignal?.aborted) {
    controller.abort();
    return controller.signal;
  }
  existingSignal?.addEventListener("abort", () => controller.abort());
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timeoutId));
  return controller.signal;
}
function simpleGlobMatch(pattern, value) {
  const parts = pattern.split("*");
  if (parts.length === 1)
    return pattern === value;
  if (!value.startsWith(parts[0]))
    return false;
  if (!value.endsWith(parts[parts.length - 1]))
    return false;
  let pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = value.indexOf(parts[i], pos);
    if (idx === -1)
      return false;
    pos = idx + parts[i].length;
  }
  return pos <= value.length - parts[parts.length - 1].length;
}
function matchesHostList(hostname, patterns) {
  return patterns.some((pattern) => simpleGlobMatch(pattern, hostname));
}
function normalizeHostname(hostname) {
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === ".") {
    end--;
  }
  return hostname.slice(0, end);
}
class ContainerState {
  storage;
  status;
  constructor(storage) {
    this.storage = storage;
  }
  async setRunning() {
    await this.setStatusAndupdate("running");
  }
  async setHealthy() {
    await this.setStatusAndupdate("healthy");
  }
  async setStopping() {
    await this.setStatusAndupdate("stopping");
  }
  async setStopped() {
    await this.setStatusAndupdate("stopped");
  }
  async setStoppedIfUnchanged(previousState) {
    if (this.status !== previousState) {
      return;
    }
    await this.setStopped();
  }
  async setStoppedWithCode(exitCode) {
    this.status = { status: "stopped_with_code", lastChange: Date.now(), exitCode };
    await this.update();
  }
  async getState() {
    if (!this.status) {
      const state2 = await this.storage.get(CONTAINER_STATE_KEY);
      if (!state2) {
        this.status = {
          status: "stopped",
          lastChange: Date.now()
        };
        await this.update();
      } else {
        this.status = state2;
      }
    }
    return this.status;
  }
  async setStatusAndupdate(status) {
    this.status = { status, lastChange: Date.now() };
    await this.update();
  }
  async update() {
    if (!this.status)
      throw new Error("status should be init");
    await this.storage.put(CONTAINER_STATE_KEY, this.status);
  }
}
class ContainerProxy extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = normalizeHostname(url.hostname);
    const { className, containerId, outboundByHostOverrides, outboundHandlerOverride, enableInternet, allowedHosts, deniedHosts, interceptAll } = this.ctx.props;
    const baseCtx = { containerId, className };
    if (deniedHosts && matchesHostList(hostname, deniedHosts)) {
      return new Response("Origin is disallowed", { status: 520 });
    }
    if (allowedHosts && !matchesHostList(hostname, allowedHosts)) {
      return new Response("Origin is disallowed", { status: 520 });
    }
    const handlers = outboundHandlersRegistry.get(className);
    if (outboundByHostOverrides && handlers) {
      const override = outboundByHostOverrides[hostname] ?? Object.entries(outboundByHostOverrides).find(([pattern]) => pattern !== hostname && simpleGlobMatch(pattern, hostname))?.[1];
      if (override && handlers[override.method]) {
        return handlers[override.method](request, this.env, {
          ...baseCtx,
          params: override.params
        });
      }
    }
    const handlersByHost = outboundByHostRegistry.get(className);
    if (handlersByHost) {
      const handler = handlersByHost[hostname] ?? Object.entries(handlersByHost).find(([pattern]) => pattern !== hostname && simpleGlobMatch(pattern, hostname))?.[1];
      if (handler) {
        return handler(request, this.env, baseCtx);
      }
    }
    if (!interceptAll) {
      if (allowedHosts || enableInternet) {
        return fetch(request);
      }
      return new Response("Origin is disallowed", { status: 520 });
    }
    if (outboundHandlerOverride && handlers?.[outboundHandlerOverride.method]) {
      return handlers[outboundHandlerOverride.method](request, this.env, {
        ...baseCtx,
        params: outboundHandlerOverride.params
      });
    }
    const defaultOutboundHandlerName = defaultOutboundHandlerNameRegistry.get(className);
    if (defaultOutboundHandlerName && handlers?.[defaultOutboundHandlerName]) {
      return handlers[defaultOutboundHandlerName](request, this.env, baseCtx);
    }
    if (allowedHosts) {
      return fetch(request);
    }
    if (enableInternet) {
      return fetch(request);
    }
    return new Response("Origin is disallowed", { status: 520 });
  }
}
class Container extends DurableObject {
  static get outboundByHost() {
    return outboundByHostRegistry.get(this.name);
  }
  static set outboundByHost(handlers) {
    outboundByHostRegistry.set(this.name, handlers);
  }
  static get outboundHandlers() {
    return outboundHandlersRegistry.get(this.name);
  }
  static set outboundHandlers(handlers) {
    const existing = outboundHandlersRegistry.get(this.name) ?? {};
    outboundHandlersRegistry.set(this.name, { ...existing, ...handlers });
  }
  static get outbound() {
    const handlerName = defaultOutboundHandlerNameRegistry.get(this.name);
    if (!handlerName)
      return void 0;
    return outboundHandlersRegistry.get(this.name)?.[handlerName];
  }
  static set outbound(handler) {
    const key = "__outbound__";
    const existing = outboundHandlersRegistry.get(this.name) ?? {};
    outboundHandlersRegistry.set(this.name, { ...existing, [key]: handler });
    defaultOutboundHandlerNameRegistry.set(this.name, key);
  }
  static get outboundProxies() {
    return this.outboundHandlers;
  }
  static set outboundProxies(handlers) {
    this.outboundHandlers = handlers;
  }
  static get outboundProxy() {
    return this.outbound;
  }
  static set outboundProxy(handler) {
    this.outbound = handler;
  }
  // =========================
  //     Public Attributes
  // =========================
  // Default port for the container (undefined means no default port)
  defaultPort;
  // Required ports that should be checked for availability during container startup
  // Override this in your subclass to specify ports that must be ready
  requiredPorts;
  // Timeout after which the container will sleep if no activity
  // The signal sent to the container by default is a SIGTERM.
  // The container won't get a SIGKILL if this threshold is triggered.
  sleepAfter = DEFAULT_SLEEP_AFTER;
  // Container configuration properties
  // Set these properties directly in your container instance
  envVars = {};
  entrypoint;
  enableInternet = true;
  labels = {};
  // When true, outbound HTTPS traffic from the container will be intercepted.
  // The container must trust /etc/cloudflare/certs/cloudflare-containers-ca.crt
  interceptHttps = false;
  // Hosts that are allowed to access the internet, even when enableInternet is false.
  // Useful for allowing specific domains on a per-host basis.
  allowedHosts;
  // Hosts that are denied internet access, even when enableInternet is true.
  // Also blocks hosts from being handled by the catch-all outbound handler.
  deniedHosts;
  // pingEndpoint is the host and path value that the class will use to send a request to the container and check if the
  // instance is ready.
  //
  // The user does not have to implement this route by any means,
  // but it's still useful if you want to control the path that
  // the Container class uses to send HTTP requests to.
  pingEndpoint = "ping";
  applyOutboundInterceptionPromise = Promise.resolve();
  usingInterception = false;
  // =========================
  //     PUBLIC INTERFACE
  // =========================
  constructor(ctx, env, options) {
    super(ctx, env);
    if (ctx.container === void 0) {
      throw new Error("Containers have not been enabled for this Durable Object class. Have you correctly setup your Wrangler config? More info: https://developers.cloudflare.com/containers/get-started/#configuration");
    }
    this.state = new ContainerState(this.ctx.storage);
    const persistedOutboundConfiguration = this.restoreOutboundConfiguration();
    this.ctx.blockConcurrencyWhile(async () => {
      await this.scheduleNextAlarm();
      this.renewActivityTimeout();
      const ctor = this.constructor;
      if (persistedOutboundConfiguration !== void 0 || ctor.outboundByHost !== void 0 || ctor.outbound !== void 0 || ctor.outboundHandlers !== void 0 || this.effectiveAllowedHosts !== void 0 || this.effectiveDeniedHosts !== void 0) {
        this.usingInterception = true;
      }
      if (this.container.running) {
        this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
      }
    });
    this.container = ctx.container;
    if (options) {
      if (options.defaultPort !== void 0)
        this.defaultPort = options.defaultPort;
      if (options.sleepAfter !== void 0)
        this.sleepAfter = options.sleepAfter;
      if (options.envVars !== void 0)
        this.envVars = options.envVars;
      if (options.entrypoint !== void 0)
        this.entrypoint = options.entrypoint;
      if (options.enableInternet !== void 0)
        this.enableInternet = options.enableInternet;
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS container_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
        callback TEXT NOT NULL,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed')),
        time INTEGER NOT NULL,
        delayInSeconds INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;
    if (this.container.running) {
      this.monitor = this.container.monitor();
      this.setupMonitorCallbacks();
    }
  }
  /**
   * Gets the current state of the container
   * @returns Promise<State>
   */
  async getState() {
    return { ...await this.state.getState() };
  }
  // ====================================
  //     OUTBOUND INTERCEPTION CONFIG
  // ====================================
  /**
   * Set the catch-all outbound handler to a named method from `outboundHandlers`.
   * Overrides the default `outbound` at runtime via ContainerProxy props.
   *
   * @param methodName - Name of a method defined in `static outboundHandlers`
   * @param params - Optional params passed to the handler as `ctx.params`
   * @throws Error if the method name is not found in `outboundHandlers`
   */
  async setOutboundHandler(methodName, ...paramsArg) {
    this.validateOutboundHandlerMethodName(methodName);
    this.outboundHandlerOverride = paramsArg.length === 0 ? { method: methodName } : { method: methodName, params: paramsArg[0] };
    await this.refreshOutboundInterception();
  }
  /**
   * Add or override a hostname-specific outbound handler at runtime,
   * referencing a named method from `outboundHandlers`.
   * Overrides any matching entry in `static outboundByHost` for this hostname.
   *
   * @param hostname - The hostname or ip:port to intercept (e.g. `'google.com'`)
   * @param methodName - Name of a method defined in `static outboundHandlers`
   * @param params - Optional params passed to the handler as `ctx.params`
   * @throws Error if the method name is not found in `outboundHandlers`
   */
  async setOutboundByHost(hostname, methodName, ...paramsArg) {
    this.validateOutboundHandlerMethodName(methodName);
    this.outboundByHostOverrides[hostname] = paramsArg.length === 0 ? { method: methodName } : { method: methodName, params: paramsArg[0] };
    await this.refreshOutboundInterception();
  }
  /**
   * Remove a runtime hostname override added via `setOutboundByHost`.
   * The default handler from `static outboundByHost` (if any) will be used again.
   *
   * @param hostname - The hostname or ip:port to stop overriding
   */
  async removeOutboundByHost(hostname) {
    delete this.outboundByHostOverrides[hostname];
    await this.refreshOutboundInterception();
  }
  /**
   * Replace all runtime hostname overrides at once.
   * Each value may be either a method name or an object with `method` and `params`.
   *
   * @param handlers - Record mapping hostnames to handler configs in `outboundHandlers`
   * @throws Error if any method name is not found in `outboundHandlers`
   */
  async setOutboundByHosts(handlers) {
    for (const handler of Object.values(handlers)) {
      const methodName = typeof handler === "string" ? handler : handler.method;
      this.validateOutboundHandlerMethodName(methodName);
    }
    this.outboundByHostOverrides = Object.fromEntries(Object.entries(handlers).map(([hostname, handler]) => [
      hostname,
      typeof handler === "string" ? { method: handler } : handler
    ]));
    await this.refreshOutboundInterception();
  }
  // ====================================
  //     ALLOWED / DENIED HOSTS CONFIG
  // ====================================
  /**
   * Replace all allowed hosts at runtime.
   * Allowed hosts get internet access even when `enableInternet` is false.
   *
   * @param hosts - Array of hostnames to allow (e.g. `['api.stripe.com', 'example.com']`)
   */
  async setAllowedHosts(hosts) {
    this.allowedHostsOverride = [...hosts];
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Replace all denied hosts at runtime.
   * Denied hosts are blocked unconditionally, even when `enableInternet` is true
   * or a catch-all outbound handler is set.
   *
   * @param hosts - Array of hostnames to deny (e.g. `['evil.com', 'blocked.org']`)
   */
  async setDeniedHosts(hosts) {
    this.deniedHostsOverride = [...hosts];
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Add a single hostname to the allowed hosts list at runtime.
   *
   * @param hostname - The hostname to allow (e.g. `'api.stripe.com'`)
   */
  async allowHost(hostname) {
    const effective = this.effectiveAllowedHosts ?? [];
    if (!effective.includes(hostname)) {
      this.allowedHostsOverride = [...effective, hostname];
    }
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Add a single hostname to the denied hosts list at runtime.
   *
   * @param hostname - The hostname to deny (e.g. `'evil.com'`)
   */
  async denyHost(hostname) {
    const effective = this.effectiveDeniedHosts ?? [];
    if (!effective.includes(hostname)) {
      this.deniedHostsOverride = [...effective, hostname];
    }
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Remove a hostname from the allowed hosts list.
   *
   * @param hostname - The hostname to remove from the allow list
   */
  async removeAllowedHost(hostname) {
    this.allowedHostsOverride = (this.effectiveAllowedHosts ?? []).filter((h) => h !== hostname);
    await this.refreshOutboundInterception();
  }
  /**
   * Remove a hostname from the denied hosts list.
   *
   * @param hostname - The hostname to remove from the deny list
   */
  async removeDeniedHost(hostname) {
    this.deniedHostsOverride = (this.effectiveDeniedHosts ?? []).filter((h) => h !== hostname);
    await this.refreshOutboundInterception();
  }
  // ==========================
  //     CONTAINER STARTING
  // ==========================
  /**
   * Start the container if it's not running and set up monitoring and lifecycle hooks,
   * without waiting for ports to be ready.
   *
   * It will automatically retry if the container fails to start, using the specified waitOptions
   *
   *
   * @example
   * await this.start({
   *   envVars: { DEBUG: 'true', NODE_ENV: 'development' },
   *   entrypoint: ['npm', 'run', 'dev'],
   *   enableInternet: false,
   *   labels: { tenant: 'acme', env: 'prod' },
   * });
   *
   * @param startOptions - Override `envVars`, `entrypoint`, `enableInternet` and `labels` on a per-instance basis
   * @param waitOptions - Optional wait configuration with abort signal for cancellation. Default ~8s timeout.
   * @returns A promise that resolves when the container start command has been issued
   * @throws Error if no container context is available or if all start attempts fail
   */
  async start(startOptions, waitOptions) {
    const portToCheck = waitOptions?.portToCheck ?? this.defaultPort ?? (this.requiredPorts ? this.requiredPorts[0] : FALLBACK_PORT_TO_CHECK);
    const pollInterval = waitOptions?.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    await this.startContainerIfNotRunning({
      signal: waitOptions?.signal,
      waitInterval: pollInterval,
      retries: waitOptions?.retries ?? Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / pollInterval),
      portToCheck
    }, startOptions);
    this.setupMonitorCallbacks();
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.onStart();
    });
  }
  async startAndWaitForPorts(portsOrArgs, cancellationOptions, startOptions) {
    let ports;
    let resolvedCancellationOptions;
    let resolvedStartOptions;
    if (typeof portsOrArgs === "object" && portsOrArgs !== null && !Array.isArray(portsOrArgs)) {
      ports = portsOrArgs.ports;
      resolvedCancellationOptions = portsOrArgs.cancellationOptions;
      resolvedStartOptions = portsOrArgs.startOptions;
    } else {
      ports = portsOrArgs;
      resolvedCancellationOptions = cancellationOptions;
      resolvedStartOptions = startOptions;
    }
    const portsToCheck = await this.getPortsToCheck(ports);
    await this.syncPendingStoppedEvents();
    resolvedCancellationOptions ??= {};
    const containerGetTimeout = resolvedCancellationOptions.instanceGetTimeoutMS ?? TIMEOUT_TO_GET_CONTAINER_MS;
    const pollInterval = resolvedCancellationOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const containerGetRetries = Math.ceil(containerGetTimeout / pollInterval);
    const waitOptions = {
      signal: resolvedCancellationOptions.abort,
      retries: containerGetRetries,
      waitInterval: pollInterval,
      portToCheck: portsToCheck[0]
    };
    const triesUsed = await this.startContainerIfNotRunning(waitOptions, resolvedStartOptions);
    const totalPortReadyTries = Math.ceil((resolvedCancellationOptions.portReadyTimeoutMS ?? TIMEOUT_TO_GET_PORTS_MS) / pollInterval);
    let triesLeft = totalPortReadyTries - triesUsed;
    for (const port of portsToCheck) {
      triesLeft = await this.waitForPort({
        signal: resolvedCancellationOptions.abort,
        waitInterval: pollInterval,
        retries: triesLeft,
        portToCheck: port
      });
    }
    this.setupMonitorCallbacks();
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.state.setHealthy();
      await this.onStart();
    });
  }
  /**
   *
   * Waits for a specified port to be ready
   *
   * Returns the number of tries used to get the port, or throws if it couldn't get the port within the specified retry limits.
   *
   * @param waitOptions -
   * - `portToCheck`: The port number to check
   * - `abort`: Optional AbortSignal to cancel waiting
   * - `retries`: Number of retries before giving up (default: TRIES_TO_GET_PORTS)
   * - `waitInterval`: Interval between retries in milliseconds (default: INSTANCE_POLL_INTERVAL_MS)
   */
  async waitForPort(waitOptions) {
    const port = waitOptions.portToCheck;
    const tcpPort = this.container.getTcpPort(port);
    const abortedSignal = new Promise((res) => {
      waitOptions.signal?.addEventListener("abort", () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const tries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_PORTS_MS / pollInterval);
    for (let i = 0; i < tries; i++) {
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        await tcpPort.fetch(`http://${this.pingEndpoint}`, { signal: combinedSignal });
        break;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (!this.container.running) {
          try {
            await this.onError(new Error(`Container crashed while checking for ports, did you start the container and setup the entrypoint correctly?`));
          } catch {
          }
          throw e;
        }
        if (i === tries - 1) {
          try {
            await this.onError(`Failed to verify port ${port} is available after ${(i + 1) * pollInterval}ms, last error: ${errorMessage}`);
          } catch {
          }
          throw e;
        }
        await Promise.any([
          new Promise((resolve) => setTimeout(resolve, pollInterval)),
          abortedSignal
        ]);
        if (waitOptions.signal?.aborted) {
          throw new Error("Container request aborted.", { cause: e });
        }
      }
    }
    return tries;
  }
  // =======================
  //     LIFECYCLE HOOKS
  // =======================
  /**
   * Send a signal to the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  async stop(signal = "SIGTERM") {
    if (this.container.running) {
      this.container.signal(typeof signal === "string" ? signalToNumbers[signal] : signal);
    }
    await this.syncPendingStoppedEvents();
  }
  /**
   * Destroys the container with a SIGKILL. Triggers onStop.
   */
  async destroy() {
    await this.container.destroy();
  }
  /**
   * Lifecycle method called when container starts successfully
   * Override this method in subclasses to handle container start events
   */
  onStart() {
  }
  /**
   * Lifecycle method called when container shuts down
   * Override this method in subclasses to handle Container stopped events
   * @param params - Object containing exitCode and reason for the stop
   */
  onStop(params) {
  }
  /**
   * Lifecycle method called when the container is running, and the activity timeout
   * expiration (set by `sleepAfter`) has been reached.
   *
   * If you want to shutdown the container, you should call this.stop() here
   *
   * By default, this method calls `this.stop()`
   */
  async onActivityExpired() {
    console.log("Activity expired, signalling container to stop");
    if (!this.container.running) {
      return;
    }
    await this.stop();
  }
  /**
   * Error handler for container errors
   * Override this method in subclasses to handle container errors
   * @param error - The error that occurred
   * @returns Can return any value or throw the error
   */
  onError(error) {
    console.error("Container error:", error);
    throw error;
  }
  /**
   * Renew the container's activity timeout
   *
   * Call this method whenever there is activity on the container
   */
  renewActivityTimeout() {
    const timeoutInMs = parseTimeExpression(this.sleepAfter) * 1e3;
    this.sleepAfterMs = Date.now() + timeoutInMs;
  }
  /**
   * Decrement the inflight request counter.
   * When the counter transitions to 0, renew the activity timeout so the
   * inactivity window starts fresh from the moment the last request completes.
   */
  decrementInflight() {
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    if (this.inflightRequests === 0) {
      this.renewActivityTimeout();
    }
  }
  // ==================
  //     SCHEDULING
  // ==================
  /**
   * Schedule a task to be executed in the future.
   *
   * We strongly recommend using this instead of the `alarm` handler.
   *
   * @template T Type of the payload data
   * @param when When to execute the task (Date object or number of seconds delay)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  async schedule(when, callback, payload) {
    const id = generateId(9);
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string (method name)");
    }
    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }
    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1e3);
      this.sql`
        INSERT OR REPLACE INTO container_schedules (id, callback, payload, type, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'scheduled', ${timestamp})
      `;
      await this.scheduleNextAlarm();
      return {
        taskId: id,
        callback,
        payload,
        time: timestamp,
        type: "scheduled"
      };
    }
    if (typeof when === "number") {
      const time = Math.floor(Date.now() / 1e3 + when);
      this.sql`
        INSERT OR REPLACE INTO container_schedules (id, callback, payload, type, delayInSeconds, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'delayed', ${when}, ${time})
      `;
      await this.scheduleNextAlarm();
      return {
        taskId: id,
        callback,
        payload,
        delayInSeconds: when,
        time,
        type: "delayed"
      };
    }
    throw new Error("Invalid schedule type. 'when' must be a Date or number of seconds");
  }
  // ============
  //     HTTP
  // ============
  /**
   * Send a request to the container (HTTP or WebSocket) using standard fetch API signature
   *
   * This method handles HTTP requests to the container.
   *
   * WebSocket requests done outside the DO won't work until https://github.com/cloudflare/workerd/issues/2319 is addressed.
   * Until then, please use `switchPort` + `fetch()`.
   *
   * Method supports multiple signatures to match standard fetch API:
   * - containerFetch(request: Request, port?: number)
   * - containerFetch(url: string | URL, init?: RequestInit, port?: number)
   *
   * Starts the container if not already running, and waits for the target port to be ready.
   *
   * @returns A Response from the container
   */
  async containerFetch(requestOrUrl, portOrInit, portParam) {
    const { request, port } = this.requestAndPortFromContainerFetchArgs(requestOrUrl, portOrInit, portParam);
    const state2 = await this.state.getState();
    if (!this.container.running || state2.status !== "healthy") {
      try {
        await this.startAndWaitForPorts(port, { abort: request.signal });
      } catch (e) {
        if (isNoInstanceError(e)) {
          return new Response("There is no Container instance available at this time.\nThis is likely because you have reached your max concurrent instance count (set in wrangler config) or are you currently provisioning the Container.\nIf you are deploying your Container for the first time, check your dashboard to see provisioning status, this may take a few minutes.", { status: 503 });
        }
        if (isRateLimitedError(e)) {
          return new Response(e instanceof Error ? e.message : String(e), { status: 429 });
        }
        return new Response(`Failed to start container: ${e instanceof Error ? e.message : String(e)}`, {
          status: 500
        });
      }
    }
    const tcpPort = this.container.getTcpPort(port);
    const containerUrl = request.url.replace("https:", "http:");
    this.inflightRequests++;
    try {
      this.renewActivityTimeout();
      const res = await tcpPort.fetch(containerUrl, request);
      if (res.webSocket !== null) {
        const containerWs = res.webSocket;
        const [client, server] = Object.values(new WebSocketPair());
        let settled = false;
        const settleInflight = () => {
          if (!settled) {
            settled = true;
            this.decrementInflight();
          }
        };
        containerWs.accept();
        server.accept();
        server.addEventListener("message", async (event2) => {
          this.renewActivityTimeout();
          try {
            const data = event2.data instanceof Blob ? await event2.data.arrayBuffer() : event2.data;
            containerWs.send(data);
          } catch {
            server.close(1011, "Failed to forward message to container");
          }
        });
        containerWs.addEventListener("message", async (event2) => {
          this.renewActivityTimeout();
          try {
            const data = event2.data instanceof Blob ? await event2.data.arrayBuffer() : event2.data;
            server.send(data);
          } catch {
            containerWs.close(1011, "Failed to forward message to client");
          }
        });
        server.addEventListener("close", (event2) => {
          settleInflight();
          const code = event2.code === 1005 || event2.code === 1006 ? 1e3 : event2.code;
          containerWs.close(code, event2.reason);
        });
        containerWs.addEventListener("close", (event2) => {
          settleInflight();
          const code = event2.code === 1005 || event2.code === 1006 ? 1e3 : event2.code;
          server.close(code, event2.reason);
        });
        server.addEventListener("error", () => {
          settleInflight();
          containerWs.close(1011, "Client WebSocket error");
        });
        containerWs.addEventListener("error", () => {
          settleInflight();
          server.close(1011, "Container WebSocket error");
        });
        return new Response(null, { status: res.status, webSocket: client, headers: res.headers });
      }
      if (res.body !== null) {
        const { readable, writable } = new IdentityTransformStream();
        res.body?.pipeTo(writable).finally(() => {
          this.decrementInflight();
        });
        return new Response(readable, res);
      }
      this.decrementInflight();
      return res;
    } catch (e) {
      this.decrementInflight();
      if (!(e instanceof Error)) {
        throw e;
      }
      if (e.message.includes("Network connection lost.")) {
        return new Response("Container suddenly disconnected, try again", { status: 500 });
      }
      console.error(`Error proxying request to container ${this.ctx.id}:`, e);
      return new Response(`Error proxying request to container: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
    }
  }
  /**
   *
   * Fetch handler on the Container class.
   * By default this forwards all requests to the container by calling `containerFetch`.
   * Use `switchPort` to specify which port on the container to target, or this will use `defaultPort`.
   * @param request The request to handle
   */
  async fetch(request) {
    if (this.defaultPort === void 0 && !request.headers.has("cf-container-target-port")) {
      throw new Error("No port configured for this container. Set the `defaultPort` in your Container subclass, or specify a port with `container.fetch(switchPort(request, port))`.");
    }
    let portValue = this.defaultPort;
    if (request.headers.has("cf-container-target-port")) {
      const portFromHeaders = parseInt(request.headers.get("cf-container-target-port") ?? "");
      if (isNaN(portFromHeaders)) {
        throw new Error("port value from switchPort is not a number");
      } else {
        portValue = portFromHeaders;
      }
    }
    return await this.containerFetch(request, portValue);
  }
  // ===============================
  // ===============================
  //     PRIVATE METHODS & ATTRS
  // ===============================
  // ===============================
  // ==========================
  //     PRIVATE ATTRIBUTES
  // ==========================
  container;
  // onStopCalled will be true when we are in the middle of an onStop call
  onStopCalled = false;
  state;
  monitor;
  // Coalesces concurrent calls to startContainerIfNotRunning so we never
  // call `this.container.start()` twice. Without this guard, two requests
  // racing the readiness path can both pass the `if (this.container.running)`
  // early-return (each yielding the DO input gate at storage awaits) and
  // both reach the synchronous workerd `start()`, causing the second to
  // throw "start() cannot be called on a container that is already running."
  // See https://github.com/cloudflare/containers/issues/173.
  startInFlight;
  monitoredPromise;
  sleepAfterMs = 0;
  inflightRequests = 0;
  // Outbound interception runtime overrides (passed through ContainerProxy props)
  outboundByHostOverrides = {};
  outboundHandlerOverride;
  // Only set when the user calls setAllowedHosts/setDeniedHosts at runtime
  allowedHostsOverride;
  deniedHostsOverride;
  // The runtime does not expose a way to remove outbound interceptions yet, so
  // once we promote an instance to intercept-all we must keep using it.
  hasInterceptAllRegistration = false;
  // ==========================
  //     GENERAL HELPERS
  // ==========================
  /**
   * Validates that a method name exists in the outboundHandlers registry for this class.
   * @throws Error if the method name is not found
   */
  validateOutboundHandlerMethodName(methodName) {
    const handlers = outboundHandlersRegistry.get(this.constructor.name);
    if (!handlers || !(methodName in handlers)) {
      throw new Error(`Outbound handler method '${methodName}' not found in outboundHandlers for ${this.constructor.name}`);
    }
  }
  get effectiveAllowedHosts() {
    return this.allowedHostsOverride ?? this.allowedHosts;
  }
  get effectiveDeniedHosts() {
    return this.deniedHostsOverride ?? this.deniedHosts;
  }
  getOutboundConfiguration() {
    return {
      outboundByHostOverrides: Object.keys(this.outboundByHostOverrides).length > 0 ? this.outboundByHostOverrides : void 0,
      outboundHandlerOverride: this.outboundHandlerOverride,
      allowedHosts: this.effectiveAllowedHosts,
      deniedHosts: this.effectiveDeniedHosts,
      hasInterceptAllRegistration: this.hasInterceptAllRegistration || void 0
    };
  }
  persistOutboundConfiguration(configuration) {
    this.ctx.storage.kv.put(OUTBOUND_CONFIGURATION_KEY, {
      ...configuration,
      allowedHosts: this.allowedHostsOverride,
      deniedHosts: this.deniedHostsOverride
    });
  }
  restoreOutboundConfiguration() {
    const configuration = this.ctx.storage.kv.get(OUTBOUND_CONFIGURATION_KEY);
    if (!configuration) {
      return void 0;
    }
    this.outboundHandlerOverride = void 0;
    if (configuration.outboundHandlerOverride !== void 0) {
      try {
        this.validateOutboundHandlerMethodName(configuration.outboundHandlerOverride.method);
        this.outboundHandlerOverride = configuration.outboundHandlerOverride;
      } catch (error) {
        console.warn("Ignoring invalid persisted outbound handler override:", error);
      }
    }
    this.outboundByHostOverrides = {};
    for (const [hostname, override] of Object.entries(configuration.outboundByHostOverrides ?? {})) {
      try {
        this.validateOutboundHandlerMethodName(override.method);
        this.outboundByHostOverrides[hostname] = override;
      } catch (error) {
        console.warn(`Ignoring invalid persisted outbound override for ${hostname}:`, error);
      }
    }
    this.hasInterceptAllRegistration = configuration.hasInterceptAllRegistration === true;
    if (configuration.allowedHosts) {
      this.allowedHostsOverride = configuration.allowedHosts;
    }
    if (configuration.deniedHosts) {
      this.deniedHostsOverride = configuration.deniedHosts;
    }
    return this.getOutboundConfiguration();
  }
  /**
   * Returns true if a catch-all outbound HTTP interception is needed.
   * This is the case when a static `outbound` handler or a runtime
   * `outboundHandlerOverride` (catch-all) is configured.
   * When false, we only intercept specific hosts to avoid overhead.
   */
  needsCatchAllInterception() {
    const ctor = this.constructor;
    return ctor.outbound !== void 0 || this.outboundHandlerOverride !== void 0;
  }
  hasMutableOutboundConfiguration() {
    return Object.keys(this.outboundByHostOverrides).length > 0 || this.allowedHostsOverride !== void 0 || this.deniedHostsOverride !== void 0;
  }
  shouldInterceptAllOutbound() {
    return this.hasInterceptAllRegistration || this.needsCatchAllInterception() || this.effectiveAllowedHosts !== void 0 || this.effectiveDeniedHosts !== void 0 || this.hasMutableOutboundConfiguration();
  }
  getStaticOutboundByHostKeys() {
    const ctor = this.constructor;
    return ctor.outboundByHost ? Object.keys(ctor.outboundByHost) : [];
  }
  /**
   * Collects all hostnames that need per-host outbound interception.
   * This path is only used for the narrow optimized case where outbound
   * handling is static and host-specific.
   */
  getHostsToIntercept() {
    const hosts = /* @__PURE__ */ new Set();
    const ctor = this.constructor;
    if (ctor.outboundByHost) {
      for (const hostname of Object.keys(ctor.outboundByHost)) {
        hosts.add(hostname);
      }
    }
    for (const hostname of Object.keys(this.outboundByHostOverrides)) {
      hosts.add(hostname);
    }
    return [...hosts];
  }
  async refreshOutboundInterception() {
    if (!this.usingInterception) {
      return;
    }
    this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
    await this.applyOutboundInterceptionPromise;
  }
  /**
   * Applies (or re-applies) outbound HTTP interception with the current
   * default registries + runtime overrides passed through ContainerProxy props.
   *
   * Uses per-host interception only for static host-specific outbound handlers.
   * As soon as the config needs to evaluate all hosts (catch-all outbound,
   * allow/deny lists, or runtime-mutated outbound config), we promote the
   * container to intercept-all and keep it there until the instance restarts.
   *
   * When `interceptHttps` is enabled, also applies HTTPS interception:
   * - Intercept-all mode: `interceptOutboundHttps('*', ...)` for all HTTPS traffic
   * - Per-host mode: `interceptOutboundHttps(host, ...)` for each known host
   */
  async applyOutboundInterception() {
    const ctx = this.ctx;
    if (ctx.exports === void 0) {
      throw new Error("ctx.exports is undefined, please try to update your compatibility date or export ContainerProxy from the containers package in your worker entrypoint");
    }
    if (ctx.exports.ContainerProxy === void 0) {
      throw new Error("ctx.exports.ContainerProxy is undefined, export ContainerProxy from the containers package in your worker entrypoint");
    }
    const interceptAll = this.shouldInterceptAllOutbound();
    if (interceptAll) {
      this.hasInterceptAllRegistration = interceptAll;
    }
    const outboundConfiguration = this.getOutboundConfiguration();
    this.persistOutboundConfiguration(outboundConfiguration);
    const hosts = this.getHostsToIntercept();
    const props = {
      enableInternet: this.enableInternet,
      containerId: this.ctx.id.toString(),
      className: this.constructor.name,
      outboundByHostOverrides: outboundConfiguration.outboundByHostOverrides,
      outboundHandlerOverride: outboundConfiguration.outboundHandlerOverride,
      allowedHosts: outboundConfiguration.allowedHosts,
      deniedHosts: outboundConfiguration.deniedHosts,
      interceptAll
    };
    const fetcher = ctx.exports.ContainerProxy({
      props
    });
    if (interceptAll) {
      for (const host of this.getStaticOutboundByHostKeys()) {
        await this.container.interceptOutboundHttp(host, fetcher);
        if (this.interceptHttps) {
          await this.container.interceptOutboundHttps(host, fetcher);
        }
      }
      if (this.interceptHttps) {
        await this.container.interceptOutboundHttps("*", fetcher);
      }
      await this.container.interceptAllOutboundHttp(fetcher);
    } else {
      for (const host of hosts) {
        await this.container.interceptOutboundHttp(host, fetcher);
        if (this.interceptHttps) {
          await this.container.interceptOutboundHttps(host, fetcher);
        }
      }
    }
  }
  /**
   * Execute SQL queries against the Container's database
   */
  sql(strings, ...values) {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? "?" : ""), "");
    return [...this.ctx.storage.sql.exec(query, ...values)];
  }
  requestAndPortFromContainerFetchArgs(requestOrUrl, portOrInit, portParam) {
    let request;
    let port;
    if (requestOrUrl instanceof Request) {
      request = requestOrUrl;
      port = typeof portOrInit === "number" ? portOrInit : void 0;
    } else {
      const url = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.toString();
      const init = typeof portOrInit === "number" ? {} : portOrInit || {};
      port = typeof portOrInit === "number" ? portOrInit : typeof portParam === "number" ? portParam : void 0;
      request = new Request(url, init);
    }
    port ??= this.defaultPort;
    if (port === void 0) {
      throw new Error("No port specified for container fetch. Set defaultPort or specify a port parameter.");
    }
    return { request, port };
  }
  /**
   *
   * The method prioritizes port sources in this order:
   * 1. Ports specified directly in the method call
   * 2. `requiredPorts` class property (if set)
   * 3. `defaultPort` (if neither of the above is specified)
   * 4. Falls back to port 33 if none of the above are set
   */
  async getPortsToCheck(overridePorts) {
    if (overridePorts !== void 0) {
      return Array.isArray(overridePorts) ? overridePorts : [overridePorts];
    }
    if (this.requiredPorts && this.requiredPorts.length > 0) {
      return [...this.requiredPorts];
    }
    return [this.defaultPort ?? FALLBACK_PORT_TO_CHECK];
  }
  // ===========================================
  //     CONTAINER INTERACTION & MONITORING
  // ===========================================
  /**
   * Tries to start a container if it's not already running
   * Returns the number of tries used
   */
  async startContainerIfNotRunning(waitOptions, options) {
    if (this.startInFlight) {
      return this.startInFlight;
    }
    if (this.container.running) {
      if (!this.monitor) {
        this.monitor = this.container.monitor();
      }
      return 0;
    }
    const startPromise = this.doStartContainer(waitOptions, options);
    this.startInFlight = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startInFlight === startPromise) {
        this.startInFlight = void 0;
      }
    }
  }
  async doStartContainer(waitOptions, options) {
    const abortedSignal = new Promise((res) => {
      waitOptions.signal?.addEventListener("abort", () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const totalTries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / pollInterval);
    for (let tries = 0; tries < totalTries; tries++) {
      const envVars = options?.envVars ?? this.envVars;
      const entrypoint = options?.entrypoint ?? this.entrypoint;
      const enableInternet = options?.enableInternet ?? this.enableInternet;
      const labels = options?.labels ?? this.labels;
      const startConfig = {
        enableInternet
      };
      if (envVars && Object.keys(envVars).length > 0)
        startConfig.env = envVars;
      if (entrypoint)
        startConfig.entrypoint = entrypoint;
      if (labels && Object.keys(labels).length > 0)
        startConfig.labels = labels;
      this.renewActivityTimeout();
      const handleError2 = async () => {
        const err = await this.monitor?.catch((err2) => err2);
        if (typeof err === "number") {
          const toThrow = new Error(`Container exited before we could determine the container health, exit code: ${err}`);
          await this.state.setStoppedWithCode(err);
          this.monitor = void 0;
          try {
            await this.onError(toThrow);
          } catch {
          }
          throw toThrow;
        } else if (!isNoInstanceError(err)) {
          await this.state.setStopped();
          this.monitor = void 0;
          try {
            await this.onError(err);
          } catch {
          }
          throw err;
        }
      };
      if (tries > 0 && !this.container.running) {
        await handleError2();
      }
      await this.scheduleNextAlarm();
      if (!this.container.running) {
        await this.refreshOutboundInterception();
        this.container.start(startConfig);
        this.monitor = this.container.monitor();
        await this.state.setRunning();
      } else {
        await this.scheduleNextAlarm();
      }
      this.renewActivityTimeout();
      const port = this.container.getTcpPort(waitOptions.portToCheck);
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        await port.fetch("http://containerstarthealthcheck", { signal: combinedSignal });
        return tries;
      } catch (error) {
        if (isNotListeningError(error) && this.container.running) {
          return tries;
        }
        if (!this.container.running && isNotListeningError(error)) {
          await handleError2();
        }
        await Promise.any([
          new Promise((res) => setTimeout(res, waitOptions.waitInterval)),
          abortedSignal
        ]);
        if (waitOptions.signal?.aborted) {
          throw new Error("Aborted waiting for container to start as we received a cancellation signal", { cause: error });
        }
        if (totalTries === tries + 1) {
          if (error instanceof Error && error.message.includes("Network connection lost")) {
            this.ctx.abort();
          }
          await handleError2();
          await this.state.setStopped();
          this.monitor = void 0;
          throw new Error(NO_CONTAINER_INSTANCE_ERROR, { cause: error });
        }
        continue;
      }
    }
    throw new Error(`Container did not start after ${totalTries * pollInterval}ms`);
  }
  setupMonitorCallbacks() {
    const monitor = this.monitor;
    if (!monitor || this.monitoredPromise === monitor) {
      return;
    }
    this.monitoredPromise = monitor;
    monitor.then(async () => {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.monitor === monitor) {
          await this.state.setStoppedWithCode(0);
        }
      });
    }).catch(async (error) => {
      if (this.monitor !== monitor) {
        return;
      }
      if (isNoInstanceError(error)) {
        await this.ctx.blockConcurrencyWhile(async () => {
          if (this.monitor === monitor) {
            await this.state.setStopped();
          }
        });
        return;
      }
      const exitCode = getExitCodeFromError(error);
      if (exitCode !== null) {
        await this.ctx.blockConcurrencyWhile(async () => {
          if (this.monitor === monitor) {
            await this.state.setStoppedWithCode(exitCode);
          }
        });
        return;
      }
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.monitor === monitor) {
          await this.state.setStopped();
        }
      });
      if (this.monitor !== monitor) {
        return;
      }
      try {
        await this.onError(error);
      } catch {
      }
    }).finally(() => {
      if (this.monitor !== monitor) {
        return;
      }
      this.monitoredPromise = void 0;
      this.monitor = void 0;
      if (this.timeout) {
        if (this.resolve)
          this.resolve();
        clearTimeout(this.timeout);
      }
    });
  }
  deleteSchedules(name) {
    this.sql`DELETE FROM container_schedules WHERE callback = ${name}`;
  }
  // ============================
  //     ALARMS AND SCHEDULES
  // ============================
  /**
   * Method called when an alarm fires
   * Executes any scheduled tasks that are due
   */
  async alarm(alarmProps) {
    if (alarmProps !== void 0 && alarmProps.isRetry && alarmProps.retryCount > MAX_ALARM_RETRIES) {
      const scheduleCount = Number(this.sql`SELECT COUNT(*) as count FROM container_schedules`[0]?.count) || 0;
      const hasScheduledTasks = scheduleCount > 0;
      if (hasScheduledTasks || this.container.running) {
        await this.scheduleNextAlarm();
      }
      return;
    }
    const prevAlarm = Date.now();
    await this.ctx.storage.setAlarm(prevAlarm);
    await this.ctx.storage.sync();
    const result = this.sql`
         SELECT * FROM container_schedules;
       `;
    let minTime = Date.now() + 3 * 60 * 1e3;
    const now2 = Date.now() / 1e3;
    for (const row of result) {
      if (row.time > now2) {
        continue;
      }
      const callback = this[row.callback];
      if (!callback || typeof callback !== "function") {
        console.error(`Callback ${row.callback} not found or is not a function`);
        continue;
      }
      const schedule = this.getSchedule(row.id);
      try {
        const payload = row.payload ? JSON.parse(row.payload) : void 0;
        await callback.call(this, payload, await schedule);
      } catch (e) {
        console.error(`Error executing scheduled callback "${row.callback}":`, e);
      }
      this.sql`DELETE FROM container_schedules WHERE id = ${row.id}`;
    }
    const resultForMinTime = this.sql`
         SELECT * FROM container_schedules;
       `;
    const minTimeFromSchedules = Math.min(...resultForMinTime.map((r) => r.time * 1e3));
    if (!this.container.running) {
      await this.syncPendingStoppedEvents();
      if (resultForMinTime.length == 0) {
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(minTimeFromSchedules);
      }
      return;
    }
    if (this.isActivityExpired()) {
      await this.onActivityExpired();
      this.renewActivityTimeout();
      return;
    }
    minTime = Math.min(minTimeFromSchedules, minTime, this.sleepAfterMs);
    const timeout = Math.max(0, minTime - Date.now());
    await new Promise((resolve) => {
      this.resolve = resolve;
      if (!this.container.running) {
        resolve();
        return;
      }
      this.timeout = setTimeout(() => {
        resolve();
      }, timeout);
    });
    await this.ctx.storage.setAlarm(Date.now());
  }
  timeout;
  resolve;
  // synchronises container state with the container source of truth to process events
  async syncPendingStoppedEvents() {
    const state2 = await this.state.getState();
    if (!this.container.running && (state2.status === "healthy" || state2.status === "running")) {
      await this.callOnStop({ exitCode: 0, reason: "exit" }, state2);
      return;
    }
    if (!this.container.running && state2.status === "stopped_with_code") {
      await this.callOnStop({ exitCode: state2.exitCode ?? 0, reason: "exit" }, state2);
      return;
    }
  }
  async callOnStop(onStopParams, stateBeforeOnStop) {
    if (this.onStopCalled) {
      return;
    }
    this.onStopCalled = true;
    const promise = this.onStop(onStopParams);
    if (promise instanceof Promise) {
      await promise.finally(() => {
        this.onStopCalled = false;
      });
    } else {
      this.onStopCalled = false;
    }
    await this.state.setStoppedIfUnchanged(stateBeforeOnStop);
  }
  /**
   * Schedule the next alarm based on upcoming tasks
   */
  async scheduleNextAlarm(ms = 1e3) {
    const nextTime = ms + Date.now();
    if (this.timeout) {
      if (this.resolve)
        this.resolve();
      clearTimeout(this.timeout);
    }
    await this.ctx.storage.setAlarm(nextTime);
    await this.ctx.storage.sync();
  }
  async listSchedules(name) {
    const result = this.sql`
      SELECT * FROM container_schedules WHERE callback = ${name} LIMIT 1
    `;
    if (!result || result.length === 0) {
      return [];
    }
    return result.map(this.toSchedule);
  }
  toSchedule(schedule) {
    let payload;
    try {
      payload = JSON.parse(schedule.payload);
    } catch (e) {
      console.error(`Error parsing payload for schedule ${schedule.id}:`, e);
      payload = void 0;
    }
    if (schedule.type === "delayed") {
      return {
        taskId: schedule.id,
        callback: schedule.callback,
        payload,
        type: "delayed",
        time: schedule.time,
        delayInSeconds: schedule.delayInSeconds
      };
    }
    return {
      taskId: schedule.id,
      callback: schedule.callback,
      payload,
      type: "scheduled",
      time: schedule.time
    };
  }
  /**
   * Get a scheduled task by ID
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  async getSchedule(id) {
    const result = this.sql`
      SELECT * FROM container_schedules WHERE id = ${id} LIMIT 1
    `;
    if (!result || result.length === 0) {
      return void 0;
    }
    const schedule = result[0];
    return this.toSchedule(schedule);
  }
  isActivityExpired() {
    if (this.inflightRequests > 0) {
      this.renewActivityTimeout();
      return false;
    }
    return this.sleepAfterMs <= Date.now();
  }
}
const objectStoreHost = "cache.r2";
async function handleObjectStore(request, env) {
  const url = new URL(request.url);
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return new Response("Invalid object key", { status: 400 });
  }
  if (!key) return new Response("Object key is required", { status: 400 });
  if (request.method === "GET") {
    const object = await env.CACHE_BUCKET.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: object.httpMetadata?.contentType ? { "content-type": object.httpMetadata.contentType } : void 0
    });
  }
  if (request.method === "PUT") {
    const object = await env.CACHE_BUCKET.put(
      key,
      request.body ?? new Uint8Array(),
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? "application/octet-stream"
        }
      }
    );
    return new Response(null, { status: object ? 201 : 412 });
  }
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "GET, PUT" }
  });
}
class ProcessorContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = false;
  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { OBJECT_STORE_ENDPOINT: `http://${objectStoreHost}` };
  }
  fetch(request) {
    return this.containerFetch(request);
  }
}
ProcessorContainer.outboundByHost = {
  [objectStoreHost]: handleObjectStore
};
const workerEntry = app ?? {};
export {
  AuditLog,
  CacheCoordinator,
  CacheIndexShard,
  ContainerProxy,
  DeleteCacheWorkflow,
  ProcessUploadWorkflow,
  ProcessorContainer,
  SystemControl,
  TokenCatalog,
  UploadJob,
  workerEntry as default
};
//# sourceMappingURL=index.js.map
