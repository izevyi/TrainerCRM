import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRegisterHandler } from "./handler";

const begin = vi.fn();
const rate = vi.fn();
const send = vi.fn();
const POST = createRegisterHandler(begin, rate, send);
function request(input: unknown) {
  return new Request("http://localhost/api/auth/register", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(input) });
}

describe("POST /api/auth/register", () => {
  beforeEach(() => { begin.mockReset(); rate.mockReset().mockResolvedValue(true); send.mockReset().mockResolvedValue(undefined); });
  it("enqueues a confirmation and never returns the token", async () => {
    begin.mockResolvedValue({email:"trainer@example.com",token:"X".repeat(43)});
    const res = await POST(request({email:"Trainer@example.com",password:"strong-pass"}));
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({status:"CHECK_EMAIL"});
    expect(begin).toHaveBeenCalledWith("trainer@example.com","strong-pass");
    expect(send).toHaveBeenCalledWith("trainer@example.com","X".repeat(43));
  });
  it("responds identically when an email is registered or in cooldown", async () => {
    begin.mockResolvedValue(null);
    const res = await POST(request({email:"trainer@example.com",password:"strong-pass"}));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({status:"CHECK_EMAIL"});
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["short", "1234567"])("rejects a short password", async (password) => {
    const res=await POST(request({email:"trainer@example.com",password}));
    expect(res.status).toBe(400);
    expect(begin).not.toHaveBeenCalled();
  });
  it("rejects oversized and extraneous request fields", async () => {
    const tooLarge = new Request("http://localhost/api/auth/register", {method:"POST",headers:{"Content-Type":"application/json"},body:"x".repeat(4097)});
    expect((await POST(tooLarge)).status).toBe(400);
    expect((await POST(request({email:"trainer@example.com",password:"abcdefgh",role:"admin"}))).status).toBe(400);
  });
  it("rate limits in DB and fails closed on unavailable database", async () => {
    rate.mockResolvedValueOnce(false);
    expect((await POST(request({email:"trainer@example.com",password:"abcdefgh"}))).status).toBe(429);
    rate.mockRejectedValue(new Error("secret database failure"));
    const response = await POST(request({email:"trainer@example.com",password:"abcdefgh"}));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
  it("fails closed on SMTP error, without returning credentials", async () => {
    begin.mockResolvedValue({email:"trainer@example.com",token:"X".repeat(43)});
    send.mockRejectedValue(new Error("SMTP_SECRET_PLAINTEXT"));
    const response=await POST(request({email:"trainer@example.com",password:"abcdefgh"}));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SMTP_SECRET");
  });
});
