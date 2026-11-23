import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifyRegistrationHandler } from "./handler";

const verify=vi.fn();
const rate=vi.fn();
const POST=createVerifyRegistrationHandler(verify,rate);
const request=(body:unknown)=>new Request("http://localhost/api/auth/verify-registration", {
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
});

describe("POST /api/auth/verify-registration", () => {
  beforeEach(()=>{verify.mockReset();rate.mockReset().mockResolvedValue(true);});
  it("confirms once without issuing a session until login",async()=>{
    verify.mockResolvedValue(true);
    const response=await POST(request({token:"X".repeat(43)}));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({status:"VERIFIED"});
  });
  it("rejects replay and expired token generically",async()=>{
    verify.mockResolvedValue(false);
    const response=await POST(request({token:"X".repeat(43)}));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_TOKEN");
  });
  it("rejects malformed body and hides internal errors",async()=>{
    expect((await POST(request({token:123}))).status).toBe(400);
    verify.mockRejectedValue(new Error("database password"));
    const response=await POST(request({token:"X".repeat(43)}));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database password");
  });
});
