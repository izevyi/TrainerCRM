import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "../database-development/migrations/011_trainer_clients_runtime.sql"),
  "utf8",
);

describe("migration 011 security boundary (static checks)", () => {
  it("uses definer functions with fixed search paths and derives ownership from sessions", () => {
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(migration.match(/SET search_path = pg_catalog, booking, authn/g)).toHaveLength(2);
    expect(migration).toContain("session.token_sha256_digest = p_token_sha256_digest");
    expect(migration).not.toMatch(/p_(trainer|tenant)_id/);
  });

  it("denies direct tables and grants only the two commands", () => {
    expect(migration).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM trainercrm_app");
    expect(migration).toContain("REVOKE ALL ON ALL SEQUENCES IN SCHEMA booking FROM trainercrm_app");
    expect(migration).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA authn FROM trainercrm_app");
    expect(migration).toContain("REVOKE ALL ON ALL SEQUENCES IN SCHEMA authn FROM trainercrm_app");
    expect(migration).not.toContain("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authn FROM trainercrm_app");
    expect(migration).not.toContain("REVOKE ALL ON SCHEMA authn FROM trainercrm_app");

    const applicationExecuteGrants = migration.match(
      /GRANT EXECUTE ON FUNCTION booking\.[\s\S]*?TO trainercrm_app;/g,
    );
    expect(applicationExecuteGrants).toEqual([
      "GRANT EXECUTE ON FUNCTION booking.list_trainer_clients(bytea) TO trainercrm_app;",
      "GRANT EXECUTE ON FUNCTION booking.create_trainer_client(bytea, text, numeric)\n  TO trainercrm_app;",
    ]);
  });

  it("sets both function ACLs before transferring ownership", () => {
    const publicRevokes = [
      "REVOKE ALL ON FUNCTION booking.list_trainer_clients(bytea) FROM PUBLIC;",
      "REVOKE ALL ON FUNCTION booking.create_trainer_client(bytea, text, numeric) FROM PUBLIC;",
    ];
    const firstOwnershipTransfer = migration.indexOf(
      "OWNER TO trainercrm_clients_function_owner",
    );

    expect(firstOwnershipTransfer).toBeGreaterThan(-1);
    for (const revoke of publicRevokes) {
      expect(migration).toContain(revoke);
      expect(migration.indexOf(revoke)).toBeLessThan(firstOwnershipTransfer);
    }

    const lastApplicationGrant = migration.lastIndexOf("TO trainercrm_app;");
    expect(lastApplicationGrant).toBeLessThan(firstOwnershipTransfer);

    const statementsAfterTransfer = migration
      .slice(firstOwnershipTransfer)
      .match(/^(?:GRANT|REVOKE)\b[^;]*;/gm);
    expect(statementsAfterTransfer).toEqual([
      "REVOKE CREATE ON SCHEMA booking FROM trainercrm_clients_function_owner;",
    ]);
  });

  it("requires and assigns a least-privilege dedicated function owner", () => {
    expect(migration).not.toMatch(/^\s*CREATE ROLE/m);
    expect(migration).toContain("rolname = 'trainercrm_clients_function_owner'");
    expect(migration).toContain("AND NOT rolcanlogin");
    expect(migration).toContain("AND NOT rolsuper");
    expect(migration).toContain("AND NOT rolcreatedb");
    expect(migration).toContain("AND NOT rolcreaterole");
    expect(migration).toContain("AND NOT rolbypassrls");
    expect(migration.match(/OWNER TO trainercrm_clients_function_owner/g)).toHaveLength(2);
    expect(migration).toContain("GRANT SELECT, INSERT ON TABLE booking.clients");
    expect(migration).toContain("'pg_catalog.gen_random_uuid()', 'EXECUTE'");
    expect(migration).not.toMatch(/GRANT ALL/);
  });
});
