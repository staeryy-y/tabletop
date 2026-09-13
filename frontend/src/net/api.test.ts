import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, auth, rooms, users } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth.login", () => {
  it("POSTs credentials as JSON to the right endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ username: "admin", isAdmin: true, mustChangePassword: true }));

    await auth.login("admin", "hunter2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body)).toEqual({ username: "admin", password: "hunter2" });
  });

  it("returns the parsed body on success", async () => {
    const body = { username: "admin", isAdmin: true, mustChangePassword: false };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(auth.login("admin", "x")).resolves.toEqual(body);
  });

  it("throws an ApiError carrying the status and server-provided detail on failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "invalid username or password" }, 401));

    await expect(auth.login("admin", "wrong")).rejects.toMatchObject({
      status: 401,
      message: "invalid username or password",
    });
  });

  it("falls back to the HTTP status text if the error body isn't JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 500, statusText: "Internal Server Error" }));

    await expect(auth.login("admin", "x")).rejects.toMatchObject({ status: 500 });
  });

  it("the rejection is a real ApiError instance", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "nope" }, 403));
    try {
      await auth.login("a", "b");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
    }
  });
});

describe("requests with no body", () => {
  it("auth.me sends a GET with no Content-Type header and no body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ username: "x", isAdmin: false, mustChangePassword: false }));
    await auth.me();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});

describe("rooms.create", () => {
  it("sends null (not omitted, not empty string) for an unset password", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ slug: "abc" }));
    await rooms.create("My Room", null);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ name: "My Room", password: null });
  });

  it("only includes game_def_ref when one is passed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ slug: "abc" }));
    await rooms.create("My Room", "secret", "bundled:dnd5e-srd");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      name: "My Room",
      password: "secret",
      game_def_ref: "bundled:dnd5e-srd",
    });
  });
});

describe("users.create", () => {
  it("maps isAdmin to the snake_case field the backend expects", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await users.create("bob", "password123", true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/users");
    expect(JSON.parse(init.body)).toEqual({ username: "bob", password: "password123", is_admin: true });
  });
});

describe("a 204 response", () => {
  it("resolves to undefined rather than trying to parse an empty body as JSON", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(auth.logout()).resolves.toBeUndefined();
  });
});
