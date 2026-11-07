import { createRequire } from "node:module";

const HEALTH_QUERY = "SELECT 1 AS ok";

interface PoolConfig {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  query_timeout: number;
  statement_timeout: number;
  allowExitOnIdle: boolean;
}

export interface DatabaseQueryResult<Row> {
  rowCount: number | null;
  rows: Row[];
}

interface PoolLike {
  query(queryText: string, values?: readonly unknown[]): Promise<DatabaseQueryResult<unknown>>;
}

type PoolConstructor = new (config: PoolConfig) => PoolLike;

export type DatabaseHealthChecker = () => Promise<boolean>;
export type DatabaseQuery = <Row>(
  queryText: string,
  values?: readonly unknown[],
) => Promise<DatabaseQueryResult<Row>>;

type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

function readDatabaseUrl(environment: DatabaseEnvironment): string | null {
  const value = environment.TRAINERCRM_DATABASE_URL;

  if (!value || value !== value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    const databaseName = url.pathname.slice(1);

    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      !databaseName ||
      databaseName.includes("/")
    ) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

export function createDatabaseHealthChecker(
  PoolImplementation: PoolConstructor,
  environment: DatabaseEnvironment,
): DatabaseHealthChecker {
  let pool: PoolLike | undefined;

  return async function checkDatabaseHealth(): Promise<boolean> {
    const connectionString = readDatabaseUrl(environment);

    if (!connectionString) {
      return false;
    }

    try {
      pool ??= new PoolImplementation({
        connectionString,
        max: 5,
        connectionTimeoutMillis: 3_000,
        idleTimeoutMillis: 10_000,
        query_timeout: 3_000,
        statement_timeout: 3_000,
        allowExitOnIdle: true,
      });

      const result = (await pool.query(HEALTH_QUERY)) as DatabaseQueryResult<{
        ok: number;
      }>;
      return result.rowCount === 1 && result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  };
}

let productionPool: PoolLike | undefined;
const requireServerModule = createRequire(import.meta.url);

function getProductionPool(): PoolLike | null {
  const connectionString = readDatabaseUrl(process.env);
  if (!connectionString) return null;

  if (!productionPool) {
    const { Pool } = requireServerModule("pg") as { Pool: PoolConstructor };
    productionPool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 10_000,
      query_timeout: 3_000,
      statement_timeout: 3_000,
      allowExitOnIdle: true,
    });
  }
  return productionPool;
}

export const queryDatabase: DatabaseQuery = async <Row>(
  queryText: string,
  values: readonly unknown[] = [],
): Promise<DatabaseQueryResult<Row>> => {
  const pool = getProductionPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  return (await pool.query(queryText, values)) as DatabaseQueryResult<Row>;
};

export async function checkDatabaseHealth(): Promise<boolean> {
  if (!readDatabaseUrl(process.env)) {
    return false;
  }

  try {
    const result = await queryDatabase<{ ok: number }>(HEALTH_QUERY);
    return result.rowCount === 1 && result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
