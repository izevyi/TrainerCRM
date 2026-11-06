import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const TRAINER_PASSWORD_MAX_BYTES = 1024;
export const TRAINER_PASSWORD_SALT_BYTES = 16;
export const TRAINER_PASSWORD_DERIVED_KEY_BYTES = 32;

const SCRYPT_VERSION = 1;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MIN_SCRYPT_COST = 16_384;
const MAX_SCRYPT_COST = 131_072;
const MAX_SCRYPT_BLOCK_SIZE = 16;
const MAX_SCRYPT_PARALLELIZATION = 4;
const HASH_PATTERN =
  /^\$scrypt\$v=([1-9][0-9]*)\$N=([1-9][0-9]*),r=([1-9][0-9]*),p=([1-9][0-9]*)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export class TrainerPasswordError extends Error {
  constructor(message: "PASSWORD_INVALID") {
    super(message);
    this.name = "TrainerPasswordError";
  }
}

type ParsedPasswordHash = {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  derivedKey: Buffer;
};

function isValidPassword(password: string): boolean {
  const length = Buffer.byteLength(password, "utf8");
  return length > 0 && length <= TRAINER_PASSWORD_MAX_BYTES;
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && Math.log2(value) % 1 === 0;
}

function decodeCanonicalBase64url(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function parsePasswordHash(encodedHash: string): ParsedPasswordHash | undefined {
  if (Buffer.byteLength(encodedHash, "utf8") > 1024) return undefined;

  const match = HASH_PATTERN.exec(encodedHash);
  if (!match) return undefined;

  const version = Number(match[1]);
  const cost = Number(match[2]);
  const blockSize = Number(match[3]);
  const parallelization = Number(match[4]);
  if (
    version !== SCRYPT_VERSION ||
    !Number.isSafeInteger(cost) ||
    !isPowerOfTwo(cost) ||
    cost < MIN_SCRYPT_COST ||
    cost > MAX_SCRYPT_COST ||
    !Number.isSafeInteger(blockSize) ||
    blockSize > MAX_SCRYPT_BLOCK_SIZE ||
    !Number.isSafeInteger(parallelization) ||
    parallelization > MAX_SCRYPT_PARALLELIZATION
  ) {
    return undefined;
  }

  const salt = decodeCanonicalBase64url(match[5]);
  const derivedKey = decodeCanonicalBase64url(match[6]);
  if (
    !salt ||
    salt.length < TRAINER_PASSWORD_SALT_BYTES ||
    salt.length > 32 ||
    !derivedKey ||
    derivedKey.length !== TRAINER_PASSWORD_DERIVED_KEY_BYTES
  ) {
    return undefined;
  }

  return { cost, blockSize, parallelization, salt, derivedKey };
}

async function derivePasswordKey(
  password: string,
  parameters: Omit<ParsedPasswordHash, "derivedKey">,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      parameters.salt,
      TRAINER_PASSWORD_DERIVED_KEY_BYTES,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: SCRYPT_MAX_MEMORY_BYTES,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashTrainerPassword(password: string): Promise<string> {
  if (!isValidPassword(password)) {
    throw new TrainerPasswordError("PASSWORD_INVALID");
  }

  const salt = randomBytes(TRAINER_PASSWORD_SALT_BYTES);
  const derivedKey = await derivePasswordKey(password, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    salt,
  });

  return `$scrypt$v=${SCRYPT_VERSION}$N=${SCRYPT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

export async function verifyTrainerPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (!isValidPassword(password)) return false;

  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;

  try {
    const candidate = await derivePasswordKey(password, parsed);
    return timingSafeEqual(parsed.derivedKey, candidate);
  } catch {
    return false;
  }
}
